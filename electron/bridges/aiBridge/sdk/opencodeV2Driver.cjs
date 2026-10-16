"use strict";

/**
 * OpenCode 2.x driver.
 *
 * OpenCode 2 replaced the embeddable SDK surface Netcatty used for 1.x with a
 * server API: `opencode serve` exposes an HTTP + SSE surface described by its
 * own `/openapi.json`. Talking to it with `fetch` keeps the dependency
 * footprint flat (the 2.x SDK pulls in `effect@4`) and leaves the turn
 * lifecycle owned by Netcatty, like every other driver here.
 *
 * One server process is spawned per turn and torn down afterwards. Boot is
 * ~100ms on a warm machine and the CLI persists sessions, so a turn resumes a
 * previous conversation by handing the recorded session id to the next
 * process.
 *
 * Wire notes (2.0.x):
 *   - `OPENCODE_SERVER_PASSWORD` fixes the server password, presented as HTTP
 *     basic auth with the literal user name `opencode`.
 *   - `OPENCODE_CONFIG_CONTENT` carries the inline config document (same env var
 *     the 1.x SDK used). Permission rules, MCP servers, the model, and the
 *     agent system text all travel there.
 *   - `/api/event` is one SSE stream for the whole server; callers must filter
 *     by `data.sessionID`.
 */

const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { mcpEnvPairsToObject } = require("./injectMcp.cjs");
const { prepareCommandForSpawn } = require("../../ai/shellUtils.cjs");
const {
  buildOpenCodeNativeSkillsPermissionRules,
  buildOpenCodeSkillsPermissionRules,
} = require("./netcattySkillsOpenCodePermissions.cjs");
const { OPENCODE_IMAGE_MEDIA_TYPES, parseOpenCodeModel } = require("./opencodeDriver.cjs");

/** Agent carrying the Netcatty system text. `build` is OpenCode's default primary agent. */
const OPENCODE_V2_AGENT = "build";
const OPENCODE_V2_SERVER_START_TIMEOUT_MS = 20000;
const OPENCODE_V2_REQUEST_TIMEOUT_MS = 60000;
const OPENCODE_V2_SHUTDOWN_GRACE_MS = 3000;
/** Share the 1.x catalog-server idle window so both runtimes behave alike. */
const OPENCODE_V2_CATALOG_IDLE_MS = 1500;
const OPENCODE_V2_OUTPUT_TAIL_CHARS = 2000;
/** Catalog failures degrade to an empty list; surface them when debugging. */
const DEBUG_OPENCODE_V2 = process.env.NETCATTY_OPENCODE_V2_DEBUG === "1";
/**
 * `opencode serve` logs its listen banner from the listener callback, but on a
 * loaded machine the first `connect` can still lose the race with `accept`.
 * Idempotent GETs are retried over a connect-level failure so a model list or
 * event stream does not fail on a transient `ECONNREFUSED`.
 */
const OPENCODE_V2_CONNECT_RETRIES = 3;
const OPENCODE_V2_CONNECT_RETRY_DELAY_MS = 100;
const OPENCODE_V2_CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function toOpenCodeV2McpServers(injectedMcpServers) {
  const servers = {};
  for (const cfg of injectedMcpServers || []) {
    if (!cfg || !cfg.name || !cfg.command) continue;
    servers[cfg.name] = {
      type: "local",
      command: [cfg.command, ...(cfg.args || [])],
      environment: mcpEnvPairsToObject(cfg.env),
      enabled: true,
    };
  }
  return servers;
}

/**
 * Build the inline OpenCode 2 config document.
 *
 * Mirrors `buildOpenCodeConfig` from the 1.x driver: local tools stay denied
 * (Netcatty has no approval bridge for OpenCode), the Netcatty MCP server is
 * injected, and skills mode opens exactly the CLI paths it needs. OpenCode 2
 * allows local writes by default, so these rules are load-bearing.
 */
function buildOpenCodeV2Config({
  model,
  injectedMcpServers,
  toolIntegrationMode,
  skillsPathAllowlist,
  systemPrompt,
} = {}) {
  const allowBash = toolIntegrationMode === "skills";
  const permission = {
    edit: "deny",
    bash: allowBash ? "allow" : "deny",
    webfetch: "deny",
    // Netcatty does not bridge OpenCode's question reply API to the UI.
    // Leaving it enabled creates a tool call that can never be completed.
    question: "deny",
    // Keep external access locked down, but let OpenCode's native skills
    // (e.g. ~/.opencode/skills, ~/.config/opencode/skills) read their own
    // reference files in every mode.
    ...buildOpenCodeNativeSkillsPermissionRules(),
  };
  if (allowBash && Array.isArray(skillsPathAllowlist) && skillsPathAllowlist.length > 0) {
    Object.assign(permission, buildOpenCodeSkillsPermissionRules(skillsPathAllowlist));
  }
  const config = {
    share: "disabled",
    autoupdate: false,
    permission,
    mcp: { servers: toOpenCodeV2McpServers(injectedMcpServers) },
  };
  if (model) config.model = String(model);
  if (systemPrompt) {
    // 2.x dropped the per-prompt `system` field the 1.x SDK accepted. Agent
    // system text is added to the built-in agent prompt, so OpenCode's own tool
    // guidance survives while Netcatty's context is included.
    config.agents = { [OPENCODE_V2_AGENT]: { system: String(systemPrompt) } };
  }
  return config;
}

function isOpenCodeV2ImageAttachment(attachment) {
  return Boolean(
    attachment &&
    OPENCODE_IMAGE_MEDIA_TYPES.has(String(attachment.mediaType || "").toLowerCase()) &&
    attachment.filePath,
  );
}

/** Prompt body: text plus image attachments referenced by file URI. */
function buildOpenCodeV2PromptBody(prompt, attachments) {
  const body = { text: String(prompt || "") };
  const files = [];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    // Match the 1.x driver: only images are forwarded, never arbitrary files.
    if (!isOpenCodeV2ImageAttachment(attachment)) continue;
    files.push({
      uri: pathToFileURL(attachment.filePath).href,
      name: attachment.filename || path.basename(attachment.filePath),
    });
  }
  if (files.length > 0) body.files = files;
  return body;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function buildOpenCodeV2AuthHeader(password) {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

function createLinkedSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const state = { timedOut: false };
  const timer = Number(timeoutMs) > 0
    ? setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, Number(timeoutMs))
    : null;
  if (typeof timer?.unref === "function") timer.unref();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    state,
    dispose() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    },
  };
}

function truncateOpenCodeV2Text(value, maxChars = OPENCODE_V2_OUTPUT_TAIL_CHARS) {
  const text = String(value || "");
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

function formatOpenCodeV2HttpError(method, route, status, body) {
  let detail = "";
  try {
    const parsed = JSON.parse(body);
    detail = String(parsed?.message || parsed?._tag || "");
  } catch {
    detail = String(body || "");
  }
  const trimmed = detail.trim().slice(0, 400);
  return `OpenCode ${method} ${route} failed (${status})${trimmed ? `: ${trimmed}` : ""}`;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function delay(ms) {
  // Deliberately ref'd: a retry in flight must keep the loop alive, otherwise a
  // pending request can be dropped when nothing else holds the event loop.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Walk the `cause` chain: undici wraps socket failures in "fetch failed". */
function isOpenCodeV2ConnectError(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (OPENCODE_V2_CONNECT_ERROR_CODES.has(String(current.code || ""))) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Fetch with a bounded retry for connect-level failures. Only safe for
 * idempotent requests (GET); callers must not use this for POST.
 */
async function fetchWithConnectRetry(doFetch, url, init, retries = OPENCODE_V2_CONNECT_RETRIES) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await doFetch(url, init);
    } catch (error) {
      if (attempt >= retries || !isOpenCodeV2ConnectError(error) || init?.signal?.aborted) {
        throw error;
      }
      await delay(OPENCODE_V2_CONNECT_RETRY_DELAY_MS * (attempt + 1));
      if (init?.signal?.aborted) throw error;
    }
  }
}

function createOpenCodeV2Client({ baseUrl, password, fetchImpl, timeoutMs } = {}) {
  const authHeader = buildOpenCodeV2AuthHeader(password);
  const doFetch = fetchImpl || globalThis.fetch;

  async function request(method, route, { body, signal, timeoutMs: perRequestTimeoutMs } = {}) {
    const scope = createLinkedSignal(
      signal,
      Number(perRequestTimeoutMs) > 0 ? Number(perRequestTimeoutMs) : timeoutMs,
    );
    try {
      const init = {
        method,
        headers: {
          authorization: authHeader,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: scope.signal,
      };
      const url = `${baseUrl}${route}`;
      const response = method === "GET" || method === "HEAD"
        ? await fetchWithConnectRetry(doFetch, url, init)
        : await doFetch(url, init);
      const text = await response.text();
      if (!response.ok) {
        throw new Error(formatOpenCodeV2HttpError(method, route, response.status, text));
      }
      if (!text) return null;
      return safeJsonParse(text);
    } finally {
      scope.dispose();
    }
  }

  /** Async iterator over one SSE stream. Aborting `signal` ends iteration. */
  async function* readEventStream({ signal, timeoutMs: streamTimeoutMs } = {}) {
    const scope = createLinkedSignal(signal, streamTimeoutMs);
    try {
      const response = await fetchWithConnectRetry(doFetch, `${baseUrl}/api/event`, {
        method: "GET",
        headers: { authorization: authHeader, accept: "text/event-stream" },
        signal: scope.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(formatOpenCodeV2HttpError("GET", "/api/event", response.status, text));
      }
      if (!response.body) throw new Error("OpenCode event stream is unavailable");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let dataLines = [];
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex < 0) break;
            const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
            buffer = buffer.slice(newlineIndex + 1);
            if (line === "") {
              if (dataLines.length === 0) continue;
              const payload = safeJsonParse(dataLines.join("\n"));
              dataLines = [];
              if (payload) yield payload;
              continue;
            }
            if (line.startsWith(":")) continue;
            if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
          }
        }
      } finally {
        try { await reader.cancel(); } catch {}
        try { reader.releaseLock(); } catch {}
      }
    } finally {
      scope.dispose();
    }
  }

  return { baseUrl, authHeader, request, readEventStream };
}

// ---------------------------------------------------------------------------
// Server process
// ---------------------------------------------------------------------------

function parseOpenCodeV2ServerLine(line) {
  const listening = /server listening on\s+(\S+)/i.exec(line);
  if (listening) return { baseUrl: listening[1] };
  const password = /server password\s+(\S+)/i.exec(line);
  if (password) return { password: password[1] };
  return null;
}

function killOpenCodeV2Child(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill("SIGTERM"); } catch {}
  const timer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
  }, OPENCODE_V2_SHUTDOWN_GRACE_MS);
  if (typeof timer.unref === "function") timer.unref();
}

/**
 * Spawn `opencode serve` on an ephemeral port and resolve once it reports its
 * listen address. `--port 0` removes the free-port race; the address is read
 * back from the server's own banner.
 */
function startOpenCodeV2Server({
  binPath,
  env,
  config,
  cwd,
  spawnImpl,
  signal,
  timeoutMs,
} = {}) {
  const command = String(binPath || env?.OPENCODE_BIN || "").trim() || "opencode";
  const password = randomBytes(32).toString("base64url");
  const serverEnv = {
    ...(env || {}),
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config || {}),
  };

  return new Promise((resolve, reject) => {
    let spec;
    try {
      spec = prepareCommandForSpawn(command, ["serve", "--hostname", "127.0.0.1", "--port", "0"]);
    } catch (error) {
      reject(error);
      return;
    }

    const spawnFn = spawnImpl || spawn;
    let child;
    try {
      child = spawnFn(spec.command, spec.args, {
        env: serverEnv,
        cwd: cwd || process.cwd(),
        shell: spec.shell,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let output = "";
    let settled = false;
    let baseUrl = null;
    let effectivePassword = password;
    let removeAbortListener = null;

    const startTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : OPENCODE_V2_SERVER_START_TIMEOUT_MS;
    const timer = setTimeout(() => {
      fail(new Error(
        `OpenCode server did not start within ${startTimeoutMs}ms`
        + `${output ? `: ${truncateOpenCodeV2Text(output, 400)}` : ""}`,
      ));
    }, startTimeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    function cleanup() {
      clearTimeout(timer);
      removeAbortListener?.();
      child.stdout?.removeAllListeners?.("data");
      child.stderr?.removeAllListeners?.("data");
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      killOpenCodeV2Child(child);
      reject(error);
    }

    function succeed() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        baseUrl,
        password: effectivePassword,
        pid: child.pid,
        outputTail: () => truncateOpenCodeV2Text(output),
        stop() {
          killOpenCodeV2Child(child);
        },
      });
    }

    const onChunk = (chunk) => {
      output += String(chunk);
      if (settled) return;
      for (const rawLine of String(chunk).split(/\r?\n/)) {
        const parsed = parseOpenCodeV2ServerLine(rawLine);
        if (!parsed) continue;
        // A server that generated its own password wins over ours: the banner
        // is the only place that value is ever published.
        if (parsed.password) effectivePassword = parsed.password;
        if (parsed.baseUrl) {
          baseUrl = parsed.baseUrl;
          succeed();
        }
      }
    };
    child.stdout?.on?.("data", onChunk);
    child.stderr?.on?.("data", onChunk);
    child.on?.("error", (error) => {
      fail(error?.code === "ENOENT"
        ? new Error("OpenCode CLI not found or not runnable. Install OpenCode and ensure `opencode` is on PATH, or set a custom path in Settings.")
        : error);
    });
    child.on?.("close", (code) => {
      fail(new Error(
        `OpenCode server exited before it was ready (code ${code ?? "unknown"})`
        + `${output ? `: ${truncateOpenCodeV2Text(output, 400)}` : ""}`,
      ));
    });

    if (signal) {
      const onAbort = () => fail(
        signal.reason instanceof Error ? signal.reason : new Error("OpenCode server start aborted"),
      );
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }
  });
}

/**
 * Start a server and build its client. The caller owns the server lifetime and
 * must call `server.stop()`; use `withOpenCodeV2Server` for the turn path.
 */
async function openOpenCodeV2Server(options) {
  const server = options.serverFactory
    ? await options.serverFactory(options)
    : await startOpenCodeV2Server(options);
  const client = createOpenCodeV2Client({
    baseUrl: server.baseUrl,
    password: server.password,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.requestTimeoutMs || OPENCODE_V2_REQUEST_TIMEOUT_MS,
  });
  return { server, client };
}

/** Start a server, hand a client to `fn`, and always tear the server down. */
async function withOpenCodeV2Server(options, fn) {
  const { server, client } = await openOpenCodeV2Server(options);
  try {
    return await fn(client, server);
  } finally {
    try { server.stop?.(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Event translation
// ---------------------------------------------------------------------------

function extractOpenCodeV2ErrorMessage(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  return String(error.message || error.data?.message || error.type || "");
}

function extractOpenCodeV2ToolResultText(payload) {
  const content = payload?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => (part && typeof part === "object" ? part.text : part))
      .filter((text) => typeof text === "string" && text.length > 0);
    if (parts.length > 0) return parts.join("\n");
  }
  if (typeof payload?.output === "string") return payload.output;
  return "";
}

function openCodeV2PartKey(data, kind) {
  return `${data?.assistantMessageID || ""}:${data?.ordinal ?? 0}:${kind}`;
}

function createOpenCodeV2TranslationState() {
  return {
    reasoningOpen: false,
    emittedParts: new Set(),
    toolCalls: new Set(),
    toolResults: new Set(),
    toolNames: new Map(),
    toolInputs: new Map(),
    tokens: { input: 0, output: 0, reasoning: 0, cached: 0 },
  };
}

function rememberOpenCodeV2Tool(state, data, input) {
  const id = data?.id;
  if (!id) return;
  if (data.name) state.toolNames.set(id, data.name);
  if (input !== undefined) state.toolInputs.set(id, input);
}

/** Emit `tool-call` at most once per call id, using whatever input is known. */
function ensureOpenCodeV2ToolCall(state, emitter, callId) {
  if (!callId || state.toolCalls.has(callId)) return false;
  state.toolCalls.add(callId);
  const name = state.toolNames.get(callId) || "tool";
  const input = state.toolInputs.get(callId);
  emitter.toolCall(name, input && typeof input === "object" ? input : {}, callId);
  return true;
}

function ensureOpenCodeV2ToolResult(state, emitter, callId, output) {
  if (!callId || state.toolResults.has(callId)) return false;
  state.toolResults.add(callId);
  emitter.toolResult(callId, output, state.toolNames.get(callId) || "tool");
  return true;
}

function emitOpenCodeV2Usage(emitter, state) {
  const { input, output, reasoning, cached } = state.tokens;
  if (!input && !output && !reasoning && !cached) return;
  emitter.usage?.({
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: input + output,
  });
}

/**
 * Translate one `opencode serve` event into stream-emitter calls.
 * Mirrors the 1.x translator contract: `{ done, error, content }`.
 */
function translateOpenCodeV2Event(event, emitter, state = createOpenCodeV2TranslationState()) {
  const type = String(event?.type || "");
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  const result = { done: false, error: false, content: false };
  if (!type) return result;

  switch (type) {
    case "session.reasoning.delta": {
      const delta = typeof data.delta === "string" ? data.delta : "";
      if (!delta) return result;
      state.emittedParts.add(openCodeV2PartKey(data, "reasoning"));
      state.reasoningOpen = true;
      emitter.reasoning(delta);
      result.content = true;
      return result;
    }

    case "session.reasoning.ended": {
      const key = openCodeV2PartKey(data, "reasoning");
      const text = typeof data.text === "string" ? data.text : "";
      // Providers that never stream reasoning deltas still publish the final
      // text; emit it so the thinking panel is not silently empty.
      if (text && !state.emittedParts.has(key)) {
        state.emittedParts.add(key);
        state.reasoningOpen = true;
        emitter.reasoning(text);
        result.content = true;
      }
      if (state.reasoningOpen) {
        emitter.reasoningEnd?.();
        state.reasoningOpen = false;
      }
      return result;
    }

    case "session.text.started": {
      if (state.reasoningOpen) {
        emitter.reasoningEnd?.();
        state.reasoningOpen = false;
      }
      return result;
    }

    case "session.text.delta": {
      const delta = typeof data.delta === "string" ? data.delta : "";
      if (!delta) return result;
      state.emittedParts.add(openCodeV2PartKey(data, "text"));
      emitter.text(delta);
      result.content = true;
      return result;
    }

    case "session.text.ended": {
      const key = openCodeV2PartKey(data, "text");
      const text = typeof data.text === "string" ? data.text : "";
      if (text && !state.emittedParts.has(key)) {
        state.emittedParts.add(key);
        emitter.text(text);
        result.content = true;
      }
      return result;
    }

    case "session.tool.input.started": {
      rememberOpenCodeV2Tool(state, data, undefined);
      state.toolInputs.set(data?.id, {});
      return result;
    }

    case "session.tool.input.ended": {
      const parsed = typeof data.text === "string" ? safeJsonParse(data.text) : null;
      rememberOpenCodeV2Tool(state, data, parsed && typeof parsed === "object" ? parsed : {});
      result.content = ensureOpenCodeV2ToolCall(state, emitter, data?.id);
      return result;
    }

    case "session.tool.called": {
      rememberOpenCodeV2Tool(
        state,
        data,
        data?.input && typeof data.input === "object" ? data.input : {},
      );
      result.content = ensureOpenCodeV2ToolCall(state, emitter, data?.id);
      return result;
    }

    case "session.tool.success": {
      rememberOpenCodeV2Tool(
        state,
        data,
        data?.input && typeof data.input === "object" ? data.input : undefined,
      );
      ensureOpenCodeV2ToolCall(state, emitter, data?.id);
      ensureOpenCodeV2ToolResult(state, emitter, data?.id, extractOpenCodeV2ToolResultText(data));
      result.content = true;
      return result;
    }

    case "session.tool.failed": {
      // Tool-level failures must not abort the turn: the model decides how to
      // recover, matching Cursor / Codex / Grok / 1.x OpenCode behavior.
      rememberOpenCodeV2Tool(
        state,
        data,
        data?.input && typeof data.input === "object" ? data.input : undefined,
      );
      ensureOpenCodeV2ToolCall(state, emitter, data?.id);
      ensureOpenCodeV2ToolResult(
        state,
        emitter,
        data?.id,
        extractOpenCodeV2ErrorMessage(data?.error) || "OpenCode tool failed",
      );
      result.content = true;
      return result;
    }

    case "session.step.ended": {
      const tokens = data?.tokens || {};
      state.tokens.input += Number(tokens.input) || 0;
      state.tokens.output += Number(tokens.output) || 0;
      state.tokens.reasoning += Number(tokens.reasoning) || 0;
      state.tokens.cached += Number(tokens.cache?.read) || 0;
      emitOpenCodeV2Usage(emitter, state);
      return result;
    }

    case "session.compaction.failed": {
      const message = extractOpenCodeV2ErrorMessage(data?.error);
      emitter.warning?.(
        "",
        message
          ? `OpenCode context compaction failed: ${message}`
          : "OpenCode context compaction failed",
      );
      return result;
    }

    case "session.error": {
      emitter.emitError(extractOpenCodeV2ErrorMessage(data?.error) || "OpenCode session failed");
      result.error = true;
      return result;
    }

    case "session.execution.succeeded":
    case "session.execution.interrupted": {
      result.done = true;
      return result;
    }

    case "session.execution.failed": {
      emitter.emitError(extractOpenCodeV2ErrorMessage(data?.error) || "OpenCode turn failed");
      result.error = true;
      result.done = true;
      return result;
    }

    default:
      return result;
  }
}

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("aborted");
}

function isOpenCodeV2NotFoundError(error) {
  return /\b404\b/.test(String(error?.message || ""));
}

async function resolveOpenCodeV2Session(client, resumeSessionId, { cwd, model, signal }) {
  if (resumeSessionId) {
    try {
      const existing = await client.request(
        "GET",
        `/api/session/${encodeURIComponent(resumeSessionId)}`,
        { signal },
      );
      if (existing) return { sessionId: resumeSessionId, resumed: true };
      throw new Error(`OpenCode session not found: ${resumeSessionId}`);
    } catch (error) {
      if (!isOpenCodeV2NotFoundError(error)) throw error;
      // A recorded session can vanish (data reset, different OpenCode home).
      // Surface it rather than silently starting a context-less conversation
      // the renderer still believes is a continuation.
      throw new Error(
        "OpenCode could not find the previous session for this chat. Start a new chat to continue.",
      );
    }
  }
  const body = {
    title: "Netcatty OpenCode",
    agent: OPENCODE_V2_AGENT,
    ...(cwd ? { location: { directory: cwd } } : {}),
  };
  const parsedModel = parseOpenCodeModel(model);
  if (parsedModel) body.model = { id: parsedModel.modelID, providerID: parsedModel.providerID };
  const created = await client.request("POST", "/api/session", { body, signal });
  const sessionId = created?.data?.id || created?.id || null;
  if (!sessionId) throw new Error("OpenCode did not create a session");
  return { sessionId, resumed: false };
}

/**
 * Answer a permission request the inline config did not pre-decide.
 *
 * Netcatty has no approval UI for OpenCode, and an unanswered request blocks
 * the turn forever. Declining keeps the documented observer-like posture
 * (local writes stay blocked) instead of hanging.
 */
async function declineOpenCodeV2Permission(client, event, emitter) {
  const data = event?.data || {};
  const sessionId = data.sessionID;
  const requestId = data.id;
  if (!sessionId || !requestId) return;
  const action = String(data.action || "action");
  const resources = Array.isArray(data.resources) ? data.resources.filter(Boolean).join(", ") : "";
  try {
    await client.request(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      {
        body: {
          decision: "reject",
          message: "Netcatty did not approve this OpenCode permission request.",
        },
      },
    );
    emitter.warning?.(
      "",
      `OpenCode asked to use ${action}${resources ? ` (${resources})` : ""}; Netcatty declined it.`,
    );
  } catch {
    // Best effort: the turn stream still reports the resulting tool failure.
  }
}

function isOpenCodeV2PermissionEvent(event) {
  const type = String(event?.type || "");
  return type === "permission.asked" || type === "session.permission.create";
}

async function runOpenCodeV2Turn({
  prompt,
  systemPrompt,
  attachments,
  cwd,
  model,
  injectedMcpServers,
  toolIntegrationMode,
  skillsPathAllowlist,
  resumeSessionId,
  env,
  binPath,
  emitter,
  abortController,
  serverFactory,
  fetchImpl,
}) {
  const signal = abortController?.signal;
  const config = buildOpenCodeV2Config({
    model,
    injectedMcpServers,
    toolIntegrationMode,
    skillsPathAllowlist,
    systemPrompt,
  });
  let sessionId = resumeSessionId || null;
  let hasContent = false;
  let failed = false;
  let interrupted = false;
  const state = createOpenCodeV2TranslationState();

  try {
    return await withOpenCodeV2Server(
      { binPath, env, config, cwd, signal, serverFactory, fetchImpl },
      async (client) => {
        // Subscribe before touching the session so no turn event can be missed.
        const stream = client.readEventStream({ signal });
        const resolved = await resolveOpenCodeV2Session(client, resumeSessionId, {
          cwd,
          model,
          signal,
        });
        sessionId = resolved.sessionId;
        emitter.sessionId(sessionId);

        const streamDone = (async () => {
          try {
            for await (const event of stream) {
              if (isOpenCodeV2PermissionEvent(event)) {
                if (!event?.data?.sessionID || event.data.sessionID === sessionId) {
                  await declineOpenCodeV2Permission(client, event, emitter);
                }
                continue;
              }
              const eventSessionId = event?.data?.sessionID;
              if (eventSessionId && eventSessionId !== sessionId) continue;
              const outcome = translateOpenCodeV2Event(event, emitter, state);
              if (outcome.content) hasContent = true;
              if (outcome.error) failed = true;
              if (outcome.done) {
                interrupted = event?.type === "session.execution.interrupted";
                return;
              }
            }
            // The stream ended without a terminal event: the server died.
            if (!failed && !signal?.aborted) {
              failed = true;
              emitter.emitError("OpenCode closed the event stream before the turn finished.");
            }
          } catch (error) {
            if (signal?.aborted) return;
            failed = true;
            emitter.emitError(extractOpenCodeV2ErrorMessage(error) || String(error));
          }
        })();

        try {
          await client.request("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
            body: buildOpenCodeV2PromptBody(prompt, attachments),
            signal,
            timeoutMs: OPENCODE_V2_REQUEST_TIMEOUT_MS,
          });
        } catch (error) {
          if (!signal?.aborted) {
            failed = true;
            emitter.emitError(extractOpenCodeV2ErrorMessage(error) || String(error));
          }
          await client
            .request("POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`)
            .catch(() => {});
          return { sessionId };
        }

        await streamDone;

        if (signal?.aborted) {
          await client
            .request("POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`)
            .catch(() => {});
          return { sessionId };
        }

        if (failed) return { sessionId };

        if (!hasContent) {
          // A server-side interrupt (for example a declined permission prompt)
          // still ends the turn; without `done` the renderer would spin forever.
          if (interrupted) {
            emitter.status?.("OpenCode turn was interrupted.");
          } else {
            emitter.emitError(
              "OpenCode returned an empty response. Run `opencode` in a terminal to configure authentication and models.",
            );
            return { sessionId };
          }
        }

        emitter.emitDone();
        return { sessionId };
      },
    );
  } catch (error) {
    if (!signal?.aborted) {
      emitter.emitError(extractOpenCodeV2ErrorMessage(error) || String(error));
    }
    return { sessionId };
  }
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

function mapOpenCodeV2Models(response) {
  const entries = Array.isArray(response?.data) ? response.data : [];
  const models = [];
  for (const entry of entries) {
    const providerId = entry?.providerID;
    const modelId = entry?.modelID || entry?.id;
    if (!providerId || !modelId) continue;
    models.push({ id: `${providerId}/${modelId}`, name: entry?.name || modelId });
  }
  return models;
}

function getOpenCodeV2DefaultModelId(response) {
  const entry = response?.data;
  if (!entry || typeof entry !== "object") return null;
  const providerId = entry.providerID;
  const modelId = entry.modelID || entry.id;
  return providerId && modelId ? `${providerId}/${modelId}` : null;
}

// Shared catalog servers: coalesce concurrent catalog loads for the same
// binary, then tear down after a short idle so an idle Netcatty does not keep
// `opencode serve` processes around.
const openCodeV2CatalogServers = new Map();

function buildOpenCodeV2CatalogKey(binPath, env) {
  return [
    String(binPath || env?.OPENCODE_BIN || "default"),
    String(env?.HOME || ""),
    String(env?.USERPROFILE || ""),
    String(env?.XDG_CONFIG_HOME || ""),
    String(env?.OPENCODE_CONFIG || ""),
    String(env?.OPENCODE_CONFIG_DIR || ""),
  ].join("\u0000");
}

function disposeOpenCodeV2CatalogServer(key, entry) {
  const current = openCodeV2CatalogServers.get(key);
  if (current && current !== entry) return;
  openCodeV2CatalogServers.delete(key);
  if (entry?.idleTimer) clearTimeout(entry.idleTimer);
  try { entry?.stop?.(); } catch {}
}

function releaseOpenCodeV2CatalogServer(key) {
  const entry = openCodeV2CatalogServers.get(key);
  if (!entry) return;
  entry.refs = Math.max(0, (entry.refs || 0) - 1);
  if (entry.refs > 0) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    const current = openCodeV2CatalogServers.get(key);
    if (!current || current !== entry || current.refs > 0) return;
    disposeOpenCodeV2CatalogServer(key, entry);
  }, OPENCODE_V2_CATALOG_IDLE_MS);
  if (typeof entry.idleTimer.unref === "function") entry.idleTimer.unref();
}

async function acquireOpenCodeV2CatalogClient({ binPath, env, serverFactory, fetchImpl, signal }) {
  if (signal?.aborted) throw abortError(signal);
  const key = buildOpenCodeV2CatalogKey(binPath, env);
  let entry = openCodeV2CatalogServers.get(key);
  if (entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  } else {
    entry = { key, refs: 0, ready: null, idleTimer: null, stop: null };
    // Unlike the turn path, the pooled catalog server must outlive this call:
    // it is torn down by the idle timer, so it cannot use the auto-stopping
    // `withOpenCodeV2Server` helper.
    entry.ready = openOpenCodeV2Server({
      binPath,
      env,
      config: { autoupdate: false, share: "disabled" },
      serverFactory,
      fetchImpl,
    }).then(({ server, client }) => {
      entry.stop = () => server.stop?.();
      return client;
    }).catch((error) => {
      disposeOpenCodeV2CatalogServer(key, entry);
      throw error;
    });
    openCodeV2CatalogServers.set(key, entry);
  }

  entry.refs += 1;
  try {
    const client = await entry.ready;
    if (signal?.aborted) throw abortError(signal);
    return { key, client };
  } catch (error) {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs <= 0) disposeOpenCodeV2CatalogServer(key, entry);
    throw error;
  }
}

function resetOpenCodeV2CatalogPool() {
  for (const [key, entry] of openCodeV2CatalogServers.entries()) {
    disposeOpenCodeV2CatalogServer(key, entry);
  }
  openCodeV2CatalogServers.clear();
}

function emptyOpenCodeV2ModelCatalog() {
  return { currentModelId: null, models: [] };
}

async function listOpenCodeV2Models({
  env,
  binPath,
  serverFactory,
  fetchImpl,
  abortController,
  signal,
} = {}) {
  const effectiveSignal = signal || abortController?.signal;
  if (effectiveSignal?.aborted) return emptyOpenCodeV2ModelCatalog();
  let acquired = null;
  try {
    acquired = await acquireOpenCodeV2CatalogClient({
      binPath,
      env,
      serverFactory,
      fetchImpl,
      signal: effectiveSignal,
    });
    const [modelsResponse, defaultResponse] = await Promise.all([
      acquired.client.request("GET", "/api/model", { signal: effectiveSignal }),
      acquired.client
        .request("GET", "/api/model/default", { signal: effectiveSignal })
        .catch(() => null),
    ]);
    return {
      currentModelId: getOpenCodeV2DefaultModelId(defaultResponse),
      models: mapOpenCodeV2Models(modelsResponse),
    };
  } catch (error) {
    if (DEBUG_OPENCODE_V2) console.error("[opencode-v2] model catalog failed:", error);
    return emptyOpenCodeV2ModelCatalog();
  } finally {
    if (acquired) releaseOpenCodeV2CatalogServer(acquired.key);
  }
}

module.exports = {
  OPENCODE_V2_AGENT,
  OPENCODE_V2_CATALOG_IDLE_MS,
  buildOpenCodeV2AuthHeader,
  buildOpenCodeV2Config,
  buildOpenCodeV2PromptBody,
  createOpenCodeV2Client,
  createOpenCodeV2TranslationState,
  declineOpenCodeV2Permission,
  extractOpenCodeV2ErrorMessage,
  getOpenCodeV2DefaultModelId,
  listOpenCodeV2Models,
  mapOpenCodeV2Models,
  parseOpenCodeV2ServerLine,
  resetOpenCodeV2CatalogPool,
  runOpenCodeV2Turn,
  startOpenCodeV2Server,
  toOpenCodeV2McpServers,
  translateOpenCodeV2Event,
};
