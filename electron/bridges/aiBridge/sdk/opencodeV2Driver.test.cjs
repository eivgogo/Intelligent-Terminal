const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  buildOpenCodeV2AuthHeader,
  buildOpenCodeV2Config,
  buildOpenCodeV2PromptBody,
  createOpenCodeV2Client,
  createOpenCodeV2TranslationState,
  declineOpenCodeV2Permission,
  getOpenCodeV2DefaultModelId,
  listOpenCodeV2Models,
  mapOpenCodeV2Models,
  parseOpenCodeV2ServerLine,
  resetOpenCodeV2CatalogPool,
  runOpenCodeV2Turn,
  startOpenCodeV2Server,
  translateOpenCodeV2Event,
} = require("./opencodeV2Driver.cjs");

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function collector() {
  const events = [];
  const emitter = {
    text: (t) => events.push({ k: "text", t }),
    reasoning: (d) => events.push({ k: "reasoning", d }),
    reasoningEnd: () => events.push({ k: "reasoningEnd" }),
    toolCall: (name, args, id) => events.push({ k: "toolCall", name, args, id }),
    toolResult: (id, out, name) => events.push({ k: "toolResult", id, out, name }),
    warning: (id, m) => events.push({ k: "warning", id, m }),
    usage: (u) => events.push({ k: "usage", u }),
    status: (m) => events.push({ k: "status", m }),
    sessionId: (s) => events.push({ k: "sessionId", s }),
    emitDone: () => events.push({ k: "done" }),
    emitError: (m) => events.push({ k: "error", m }),
  };
  return { events, emitter };
}

function jsonResponse(status, json) {
  const text = json === undefined ? "" : JSON.stringify(json);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    body: null,
  };
}

/** SSE body stand-in that splits the payload into arbitrary chunk boundaries. */
function createSseBody(events, { chunkSize = 64, ready } = {}) {
  const encoder = new TextEncoder();
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const chunks = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (ready) await ready();
          if (index >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: encoder.encode(chunks[index++]) };
        },
        async cancel() { index = chunks.length; },
        releaseLock() {},
      };
    },
  };
}

function createFakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const route = `${options.method || "GET"} ${parsed.pathname}`;
    const call = {
      route,
      pathname: parsed.pathname,
      options,
      body: options.body ? JSON.parse(options.body) : undefined,
    };
    calls.push(call);
    const result = handler(route, call);
    if (!result) return jsonResponse(404, { _tag: "NotFoundError" });
    if (result.bodyStream) {
      return { ok: true, status: 200, body: result.bodyStream, text: async () => "" };
    }
    return jsonResponse(result.status ?? 200, result.json);
  };
  return { fetchImpl, calls };
}

function createServerFactory(overrides = {}) {
  const servers = [];
  const serverFactory = async (options) => {
    const server = {
      baseUrl: "http://127.0.0.1:9",
      password: "test-password",
      options,
      stopped: false,
      stop() { this.stopped = true; },
      ...overrides,
    };
    servers.push(server);
    return server;
  };
  return { serverFactory, servers };
}

function createFakeSpawnChild({ stdout = "", code = 0, error = null, delayMs = 5 }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; child.exitCode = code ?? 0; };
  setTimeout(() => {
    if (error) {
      child.emit("error", error);
      return;
    }
    if (stdout) child.stdout.emit("data", stdout);
    if (code !== 0) child.emit("close", code);
  }, delayMs);
  return child;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test("buildOpenCodeV2Config mirrors 1.x tool isolation and injects Netcatty MCP", () => {
  const config = buildOpenCodeV2Config({
    model: "openai/gpt-5.1",
    injectedMcpServers: [{
      name: "netcatty-remote-hosts",
      command: "/abs/electron",
      args: ["/abs/server.cjs"],
      env: [{ name: "NETCATTY_MCP_PORT", value: "1" }],
    }],
  });

  assert.equal(config.model, "openai/gpt-5.1");
  assert.equal(config.share, "disabled");
  assert.equal(config.autoupdate, false);
  assert.equal(config.permission.edit, "deny");
  assert.equal(config.permission.bash, "deny");
  assert.equal(config.permission.webfetch, "deny");
  assert.equal(config.permission.question, "deny");
  assert.equal(config.permission.skill, "allow");
  assert.equal(config.permission.external_directory["*"], "deny");
  assert.equal(config.permission.external_directory["*.opencode/skills/**"], "allow");
  assert.deepEqual(config.mcp.servers["netcatty-remote-hosts"], {
    type: "local",
    command: ["/abs/electron", "/abs/server.cjs"],
    environment: { NETCATTY_MCP_PORT: "1" },
    enabled: true,
  });
  assert.equal(config.agents, undefined);
});

test("buildOpenCodeV2Config allowlists Netcatty CLI paths in skills mode", () => {
  const config = buildOpenCodeV2Config({
    toolIntegrationMode: "skills",
    skillsPathAllowlist: [
      "/Applications/Netcatty.app/Contents/MacOS/**",
      "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/**",
    ],
  });

  assert.equal(config.permission.bash, "allow");
  assert.equal(config.permission.list, "deny");
  assert.equal(config.permission.external_directory["*"], "deny");
  assert.equal(
    config.permission.external_directory["/Applications/Netcatty.app/Contents/MacOS/**"],
    "allow",
  );
});

test("buildOpenCodeV2Config routes the system prompt onto the build agent", () => {
  const config = buildOpenCodeV2Config({ systemPrompt: "You are Netcatty." });
  assert.deepEqual(config.agents, { build: { system: "You are Netcatty." } });
});

test("buildOpenCodeV2PromptBody forwards images as file URIs only", () => {
  assert.deepEqual(
    buildOpenCodeV2PromptBody("describe", [
      { filename: "shot.png", mediaType: "image/png", filePath: "/tmp/shot.png", base64Data: "abc" },
      { filename: "bad.svg", mediaType: "image/svg+xml", filePath: "/tmp/bad.svg" },
      { filename: "notes.txt", mediaType: "text/plain", filePath: "/tmp/notes.txt" },
    ]),
    { text: "describe", files: [{ uri: "file:///tmp/shot.png", name: "shot.png" }] },
  );
  assert.deepEqual(buildOpenCodeV2PromptBody("hi", []), { text: "hi" });
});

test("buildOpenCodeV2AuthHeader uses basic auth with the opencode user", () => {
  assert.equal(buildOpenCodeV2AuthHeader("pw"), `Basic ${Buffer.from("opencode:pw").toString("base64")}`);
});

// ---------------------------------------------------------------------------
// Server process
// ---------------------------------------------------------------------------

test("parseOpenCodeV2ServerLine reads the listen banner and password", () => {
  assert.deepEqual(
    parseOpenCodeV2ServerLine("server listening on http://127.0.0.1:51234"),
    { baseUrl: "http://127.0.0.1:51234" },
  );
  assert.deepEqual(parseOpenCodeV2ServerLine("server password abc-123"), { password: "abc-123" });
  assert.equal(parseOpenCodeV2ServerLine("some other log line"), null);
});

test("startOpenCodeV2Server resolves on the banner and passes the inline config", async () => {
  const calls = [];
  const child = createFakeSpawnChild({ stdout: "server listening on http://127.0.0.1:40123\n" });
  const server = await startOpenCodeV2Server({
    binPath: "/opt/opencode",
    env: { PATH: "/usr/bin" },
    config: { share: "disabled" },
    cwd: "/tmp/project",
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
  });

  assert.equal(server.baseUrl, "http://127.0.0.1:40123");
  assert.equal(server.password.length > 20, true);
  assert.deepEqual(calls[0].args, ["serve", "--hostname", "127.0.0.1", "--port", "0"]);
  assert.equal(calls[0].options.cwd, "/tmp/project");
  assert.equal(calls[0].options.env.OPENCODE_SERVER_PASSWORD, server.password);
  assert.deepEqual(JSON.parse(calls[0].options.env.OPENCODE_CONFIG_CONTENT), { share: "disabled" });
  server.stop();
});

test("startOpenCodeV2Server adopts a server-generated password when one is printed", async () => {
  const child = createFakeSpawnChild({
    stdout: "server password generated-pw\nserver listening on http://127.0.0.1:40124\n",
  });
  const server = await startOpenCodeV2Server({
    binPath: "/opt/opencode",
    env: {},
    config: {},
    spawnImpl: () => child,
  });
  assert.equal(server.password, "generated-pw");
  server.stop();
});

test("startOpenCodeV2Server rejects when the CLI exits before listening", async () => {
  const child = createFakeSpawnChild({ stdout: "boom\n", code: 127 });
  await assert.rejects(
    () => startOpenCodeV2Server({
      binPath: "/opt/opencode",
      env: {},
      config: {},
      spawnImpl: () => child,
    }),
    /exited before it was ready/,
  );
});

test("startOpenCodeV2Server reports a missing CLI", async () => {
  const child = createFakeSpawnChild({ error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) });
  await assert.rejects(
    () => startOpenCodeV2Server({
      binPath: "/opt/opencode",
      env: {},
      config: {},
      spawnImpl: () => child,
    }),
    /OpenCode CLI not found/,
  );
});

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

test("client surfaces non-2xx responses with the server message", async () => {
  const { fetchImpl } = createFakeFetch(() => ({
    status: 401,
    json: { _tag: "UnauthorizedError", message: "Authentication required" },
  }));
  const client = createOpenCodeV2Client({ baseUrl: "http://127.0.0.1:1", password: "pw", fetchImpl });
  await assert.rejects(
    () => client.request("GET", "/api/info"),
    /OpenCode GET \/api\/info failed \(401\): Authentication required/,
  );
});

test("client parses SSE payloads split across arbitrary chunk boundaries", async () => {
  const events = [
    { type: "session.text.delta", data: { sessionID: "ses_1", delta: "a" } },
    { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
  ];
  const { fetchImpl } = createFakeFetch(() => ({ bodyStream: createSseBody(events, { chunkSize: 7 }) }));
  const client = createOpenCodeV2Client({ baseUrl: "http://127.0.0.1:1", password: "pw", fetchImpl });

  const seen = [];
  for await (const event of client.readEventStream({})) seen.push(event);
  assert.deepEqual(seen, events);
});

test("client retries an idempotent GET once the server finishes binding", async () => {
  // The listen banner can beat the first accept, so a transient ECONNREFUSED
  // must not surface as an empty model list.
  let calls = 0;
  const fetchImpl = async (url, options = {}) => {
    calls += 1;
    if (calls === 1) {
      const error = new TypeError("fetch failed");
      error.cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      throw error;
    }
    return jsonResponse(200, { data: [{ providerID: "opencode", modelID: "m1" }] });
  };
  const client = createOpenCodeV2Client({ baseUrl: "http://127.0.0.1:1", password: "pw", fetchImpl });

  const response = await client.request("GET", "/api/model");
  assert.equal(calls, 2);
  assert.deepEqual(response.data, [{ providerID: "opencode", modelID: "m1" }]);
});

test("client never retries a POST so a turn cannot be sent twice", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const error = new TypeError("fetch failed");
    error.cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    throw error;
  };
  const client = createOpenCodeV2Client({ baseUrl: "http://127.0.0.1:1", password: "pw", fetchImpl });

  await assert.rejects(() => client.request("POST", "/api/session", { body: { title: "x" } }), /fetch failed/);
  assert.equal(calls, 1);
});

test("client does not retry non-connection failures", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("boom");
  };
  const client = createOpenCodeV2Client({ baseUrl: "http://127.0.0.1:1", password: "pw", fetchImpl });

  await assert.rejects(() => client.request("GET", "/api/model"), /boom/);
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// Event translation
// ---------------------------------------------------------------------------

test("translateOpenCodeV2Event streams reasoning then text and reports usage", () => {
  const { events, emitter } = collector();
  const state = createOpenCodeV2TranslationState();

  translateOpenCodeV2Event({ type: "session.reasoning.delta", data: { assistantMessageID: "m1", ordinal: 0, delta: "think" } }, emitter, state);
  translateOpenCodeV2Event({ type: "session.text.started", data: { assistantMessageID: "m1", ordinal: 0 } }, emitter, state);
  const textOutcome = translateOpenCodeV2Event({ type: "session.text.delta", data: { assistantMessageID: "m1", ordinal: 0, delta: "hello" } }, emitter, state);
  translateOpenCodeV2Event({
    type: "session.step.ended",
    data: { tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 4 } } },
  }, emitter, state);
  const done = translateOpenCodeV2Event({ type: "session.execution.succeeded", data: {} }, emitter, state);

  assert.deepEqual(events, [
    { k: "reasoning", d: "think" },
    { k: "reasoningEnd" },
    { k: "text", t: "hello" },
    { k: "usage", u: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, reasoningTokens: 3, totalTokens: 12 } },
  ]);
  assert.equal(textOutcome.content, true);
  assert.equal(done.done, true);
});

test("translateOpenCodeV2Event emits finished parts that never streamed deltas", () => {
  const { events, emitter } = collector();
  translateOpenCodeV2Event({
    type: "session.reasoning.ended",
    data: { assistantMessageID: "m1", ordinal: 0, text: "all at once" },
  }, emitter);
  translateOpenCodeV2Event({
    type: "session.text.ended",
    data: { assistantMessageID: "m1", ordinal: 0, text: "final answer" },
  }, emitter);

  assert.deepEqual(events, [
    { k: "reasoning", d: "all at once" },
    { k: "reasoningEnd" },
    { k: "text", t: "final answer" },
  ]);
});

test("translateOpenCodeV2Event pairs tool calls with results without aborting the turn", () => {
  const { events, emitter } = collector();
  const state = createOpenCodeV2TranslationState();

  translateOpenCodeV2Event({ type: "session.tool.input.started", data: { id: "call-1", name: "shell" } }, emitter, state);
  translateOpenCodeV2Event({ type: "session.tool.input.ended", data: { id: "call-1", text: "{\"command\":\"ls\"}" } }, emitter, state);
  translateOpenCodeV2Event({ type: "session.tool.called", data: { id: "call-1", input: { command: "ls" } } }, emitter, state);
  translateOpenCodeV2Event({
    type: "session.tool.success",
    data: { id: "call-1", content: [{ type: "text", text: "file.txt\n" }] },
  }, emitter, state);
  translateOpenCodeV2Event({
    type: "session.tool.failed",
    data: { id: "call-2", error: { type: "tool.execution", message: "File not found" } },
  }, emitter, state);
  const outcome = translateOpenCodeV2Event({ type: "session.execution.succeeded", data: {} }, emitter, state);

  assert.deepEqual(events, [
    { k: "toolCall", name: "shell", args: { command: "ls" }, id: "call-1" },
    { k: "toolResult", id: "call-1", out: "file.txt\n", name: "shell" },
    { k: "toolCall", name: "tool", args: {}, id: "call-2" },
    { k: "toolResult", id: "call-2", out: "File not found", name: "tool" },
  ]);
  assert.equal(outcome.error, false);
  assert.equal(outcome.done, true);
});

test("translateOpenCodeV2Event reports execution failures and session errors", () => {
  const failure = collector();
  const failureOutcome = translateOpenCodeV2Event({
    type: "session.execution.failed",
    data: { error: { type: "provider.no-route", message: "Model unavailable: nope/does-not-exist" } },
  }, failure.emitter);
  assert.deepEqual(failure.events, [{ k: "error", m: "Model unavailable: nope/does-not-exist" }]);
  assert.equal(failureOutcome.error, true);
  assert.equal(failureOutcome.done, true);

  const interrupted = collector();
  const interruptedOutcome = translateOpenCodeV2Event(
    { type: "session.execution.interrupted", data: { reason: "user" } },
    interrupted.emitter,
  );
  assert.deepEqual(interrupted.events, []);
  assert.equal(interruptedOutcome.done, true);
  assert.equal(interruptedOutcome.error, false);
});

test("translateOpenCodeV2Event warns on compaction failures and ignores bookkeeping events", () => {
  const { events, emitter } = collector();
  translateOpenCodeV2Event({ type: "session.created", data: { sessionID: "ses_1" } }, emitter);
  translateOpenCodeV2Event({ type: "session.compaction.failed", data: { error: { message: "boom" } } }, emitter);
  translateOpenCodeV2Event({ type: "session.inbox.delivered", data: { sessionID: "ses_1" } }, emitter);

  assert.deepEqual(events, [{ k: "warning", id: "", m: "OpenCode context compaction failed: boom" }]);
});

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

test("runOpenCodeV2Turn creates a session, streams the reply, and tears the server down", async () => {
  const { serverFactory, servers } = createServerFactory();
  const sseEvents = [
    { type: "session.text.delta", data: { sessionID: "ses_other", delta: "ignored" } },
    { type: "session.execution.started", data: { sessionID: "ses_new" } },
    { type: "session.text.delta", data: { sessionID: "ses_new", assistantMessageID: "m1", ordinal: 0, delta: "hi " } },
    { type: "session.text.delta", data: { sessionID: "ses_new", assistantMessageID: "m1", ordinal: 0, delta: "there" } },
    { type: "session.execution.succeeded", data: { sessionID: "ses_new" } },
  ];
  const { fetchImpl, calls } = createFakeFetch((route) => {
    if (route === "GET /api/event") return { bodyStream: createSseBody(sseEvents) };
    if (route === "POST /api/session") return { json: { data: { id: "ses_new" } } };
    if (route === "POST /api/session/ses_new/prompt") return { json: { data: { id: "msg_1" } } };
    return null;
  });
  const { events, emitter } = collector();

  const result = await runOpenCodeV2Turn({
    prompt: "hello",
    systemPrompt: "You are Netcatty.",
    attachments: [],
    cwd: "/tmp/project",
    model: "opencode/nemotron-3.5-lightning-free",
    injectedMcpServers: [],
    resumeSessionId: null,
    env: {},
    binPath: "/opt/opencode",
    emitter,
    abortController: new AbortController(),
    serverFactory,
    fetchImpl,
  });

  assert.deepEqual(result, { sessionId: "ses_new" });
  assert.deepEqual(events, [
    { k: "sessionId", s: "ses_new" },
    { k: "text", t: "hi " },
    { k: "text", t: "there" },
    { k: "done" },
  ]);

  const createCall = calls.find((call) => call.route === "POST /api/session");
  assert.deepEqual(createCall.body, {
    title: "Netcatty OpenCode",
    agent: "build",
    location: { directory: "/tmp/project" },
    model: { id: "nemotron-3.5-lightning-free", providerID: "opencode" },
  });
  const promptCall = calls.find((call) => call.route === "POST /api/session/ses_new/prompt");
  assert.deepEqual(promptCall.body, { text: "hello" });

  const config = servers[0].options.config;
  assert.equal(config.permission.edit, "deny");
  assert.deepEqual(config.agents, { build: { system: "You are Netcatty." } });
  assert.equal(servers[0].stopped, true);
});

test("runOpenCodeV2Turn resumes a recorded session and keeps its context", async () => {
  const { serverFactory } = createServerFactory();
  const sseEvents = [
    { type: "session.text.delta", data: { sessionID: "ses_old", assistantMessageID: "m1", ordinal: 0, delta: "4242" } },
    { type: "session.execution.succeeded", data: { sessionID: "ses_old" } },
  ];
  const { fetchImpl, calls } = createFakeFetch((route) => {
    if (route === "GET /api/event") return { bodyStream: createSseBody(sseEvents) };
    if (route === "GET /api/session/ses_old") return { json: { data: { id: "ses_old" } } };
    if (route === "POST /api/session/ses_old/prompt") return { json: { data: { id: "msg_2" } } };
    return null;
  });
  const { events, emitter } = collector();

  const result = await runOpenCodeV2Turn({
    prompt: "what number?",
    attachments: [],
    cwd: "/tmp/project",
    resumeSessionId: "ses_old",
    env: {},
    binPath: "/opt/opencode",
    emitter,
    abortController: new AbortController(),
    serverFactory,
    fetchImpl,
  });

  assert.deepEqual(result, { sessionId: "ses_old" });
  assert.equal(calls.some((call) => call.route === "POST /api/session"), false);
  assert.deepEqual(events, [
    { k: "sessionId", s: "ses_old" },
    { k: "text", t: "4242" },
    { k: "done" },
  ]);
});

test("runOpenCodeV2Turn reports a vanished session instead of starting over", async () => {
  const { serverFactory, servers } = createServerFactory();
  const { fetchImpl, calls } = createFakeFetch((route) => {
    if (route === "GET /api/event") return { bodyStream: createSseBody([]) };
    if (route === "GET /api/session/ses_gone") return { status: 404, json: { _tag: "SessionNotFoundError" } };
    return null;
  });
  const { events, emitter } = collector();

  const result = await runOpenCodeV2Turn({
    prompt: "hello",
    attachments: [],
    cwd: "/tmp/project",
    resumeSessionId: "ses_gone",
    env: {},
    binPath: "/opt/opencode",
    emitter,
    abortController: new AbortController(),
    serverFactory,
    fetchImpl,
  });

  assert.deepEqual(result, { sessionId: "ses_gone" });
  assert.equal(calls.some((call) => call.route.includes("/prompt")), false);
  assert.equal(events.length, 1);
  assert.match(events[0].m, /could not find the previous session/);
  assert.equal(servers[0].stopped, true);
});

test("runOpenCodeV2Turn surfaces an empty response like the 1.x driver", async () => {
  const { serverFactory } = createServerFactory();
  const { fetchImpl } = createFakeFetch((route) => {
    if (route === "GET /api/event") {
      return { bodyStream: createSseBody([{ type: "session.execution.succeeded", data: { sessionID: "ses_new" } }]) };
    }
    if (route === "POST /api/session") return { json: { data: { id: "ses_new" } } };
    if (route === "POST /api/session/ses_new/prompt") return { json: { data: { id: "msg_1" } } };
    return null;
  });
  const { events, emitter } = collector();

  await runOpenCodeV2Turn({
    prompt: "hello",
    attachments: [],
    cwd: "/tmp/project",
    env: {},
    binPath: "/opt/opencode",
    emitter,
    abortController: new AbortController(),
    serverFactory,
    fetchImpl,
  });

  assert.equal(events.some((event) => event.k === "done"), false);
  assert.match(events.at(-1).m, /returned an empty response/);
});

test("runOpenCodeV2Turn closes an interrupted turn that never produced content", async () => {
  // A server-side interrupt (for example a declined permission prompt) ends the
  // turn without content; the renderer still needs a terminal `done` event.
  const { serverFactory } = createServerFactory();
  const { fetchImpl } = createFakeFetch((route) => {
    if (route === "GET /api/event") {
      return { bodyStream: createSseBody([{ type: "session.execution.interrupted", data: { sessionID: "ses_new", reason: "user" } }]) };
    }
    if (route === "POST /api/session") return { json: { data: { id: "ses_new" } } };
    if (route === "POST /api/session/ses_new/prompt") return { json: { data: { id: "msg_1" } } };
    return null;
  });
  const { events, emitter } = collector();

  const result = await runOpenCodeV2Turn({
    prompt: "hello",
    attachments: [],
    cwd: "/tmp/project",
    env: {},
    binPath: "/opt/opencode",
    emitter,
    abortController: new AbortController(),
    serverFactory,
    fetchImpl,
  });

  assert.deepEqual(result, { sessionId: "ses_new" });
  assert.equal(events.some((event) => event.k === "error"), false);
  assert.deepEqual(events.at(-1), { k: "done" });
  assert.equal(
    events.some((event) => event.k === "status" && /interrupted/.test(event.m)),
    true,
  );
});

test("runOpenCodeV2Turn declines unexpected permission prompts so the turn cannot hang", async () => {
  const { serverFactory } = createServerFactory();
  const sseEvents = [
    { type: "permission.asked", data: { id: "per_1", sessionID: "ses_new", action: "shell", resources: ["echo hi"] } },
    { type: "session.tool.failed", data: { sessionID: "ses_new", id: "call-1", error: { message: "declined" } } },
    { type: "session.text.delta", data: { sessionID: "ses_new", assistantMessageID: "m1", ordinal: 0, delta: "cannot" } },
    { type: "session.execution.succeeded", data: { sessionID: "ses_new" } },
  ];
  const { fetchImpl, calls } = createFakeFetch((route) => {
    if (route === "GET /api/event") return { bodyStream: createSseBody(sseEvents) };
    if (route === "POST /api/session") return { json: { data: { id: "ses_new" } } };
    if (route === "POST /api/session/ses_new/prompt") return { json: { data: { id: "msg_1" } } };
    if (route === "POST /api/session/ses_new/permission/per_1/reply") return { json: { data: {} } };
    return null;
  });
  const { events, emitter } = collector();

  await runOpenCodeV2Turn({
    prompt: "run it",
    attachments: [],
    cwd: "/tmp/project",
    env: {},
    binPath: "/opt/opencode",
    emitter,
    abortController: new AbortController(),
    serverFactory,
    fetchImpl,
  });

  const replyCall = calls.find((call) => call.route.endsWith("/permission/per_1/reply"));
  assert.equal(replyCall.body.decision, "reject");
  assert.equal(
    events.some((event) => event.k === "warning" && /Netcatty declined it/.test(event.m)),
    true,
  );
  assert.equal(events.at(-1).k, "done");
});

test("declineOpenCodeV2Permission ignores events without a request id", async () => {
  const calls = [];
  const client = { request: async (...args) => { calls.push(args); return null; } };
  const { events, emitter } = collector();
  await declineOpenCodeV2Permission(client, { type: "permission.asked", data: { sessionID: "ses_1" } }, emitter);
  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
});

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

test("mapOpenCodeV2Models flattens provider/model entries", () => {
  assert.deepEqual(
    mapOpenCodeV2Models({
      data: [
        { providerID: "opencode", modelID: "nemotron-3.5-lightning-free", name: "Nemotron Lightning" },
        { providerID: "nvidia", modelID: "nvidia/nemotron-3.5-super-vl-120b-a12b" },
        { providerID: null, modelID: "ignored" },
      ],
    }),
    [
      { id: "opencode/nemotron-3.5-lightning-free", name: "Nemotron Lightning" },
      { id: "nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b", name: "nvidia/nemotron-3.5-super-vl-120b-a12b" },
    ],
  );
  assert.deepEqual(mapOpenCodeV2Models(null), []);
});

test("getOpenCodeV2DefaultModelId reads the server default", () => {
  assert.equal(
    getOpenCodeV2DefaultModelId({ data: { providerID: "deepseek", modelID: "deepseek-flash" } }),
    "deepseek/deepseek-flash",
  );
  assert.equal(getOpenCodeV2DefaultModelId({ data: null }), null);
  assert.equal(getOpenCodeV2DefaultModelId(null), null);
});

test("listOpenCodeV2Models serves the catalog and reuses the shared server", async () => {
  resetOpenCodeV2CatalogPool();
  const { serverFactory, servers } = createServerFactory();
  const { fetchImpl, calls } = createFakeFetch((route) => {
    if (route === "GET /api/model") {
      return { json: { data: [{ providerID: "opencode", modelID: "nemotron-3.5-lightning-free" }] } };
    }
    if (route === "GET /api/model/default") {
      return { json: { data: { providerID: "deepseek", modelID: "deepseek-flash" } } };
    }
    return null;
  });

  const catalog = await listOpenCodeV2Models({ env: {}, binPath: "/opt/opencode", serverFactory, fetchImpl });
  assert.deepEqual(catalog, {
    currentModelId: "deepseek/deepseek-flash",
    models: [{ id: "opencode/nemotron-3.5-lightning-free", name: "nemotron-3.5-lightning-free" }],
  });
  // The pooled server must outlive the request that created it, otherwise the
  // next catalog load talks to a dead process (ECONNREFUSED).
  assert.equal(servers[0].stopped, false, "pooled catalog server stays alive after the call");

  await listOpenCodeV2Models({ env: {}, binPath: "/opt/opencode", serverFactory, fetchImpl });
  assert.equal(servers.length, 1, "catalog servers are pooled per binary");
  assert.equal(calls.filter((call) => call.route === "GET /api/model").length, 2);

  resetOpenCodeV2CatalogPool();
  assert.equal(servers[0].stopped, true);
});

test("listOpenCodeV2Models degrades to an empty catalog", async () => {
  resetOpenCodeV2CatalogPool();
  const { serverFactory } = createServerFactory();
  const { fetchImpl } = createFakeFetch(() => ({ status: 503, json: { _tag: "ServiceUnavailableError" } }));
  assert.deepEqual(
    await listOpenCodeV2Models({ env: {}, binPath: "/opt/opencode", serverFactory, fetchImpl }),
    { currentModelId: null, models: [] },
  );
  resetOpenCodeV2CatalogPool();
});
