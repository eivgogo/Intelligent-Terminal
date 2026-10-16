"use strict";

/**
 * OpenCode dual-runtime resolution.
 *
 * Netcatty drives OpenCode through a single SDK backend key (`opencode`), but
 * the two CLI generations need two different transports:
 *
 *   - 1.x -> `@opencode-ai/sdk` in-process client (`opencodeDriver.cjs`)
 *   - 2.x -> `opencode serve` HTTP + SSE API   (`opencodeV2Driver.cjs`)
 *
 * The installed CLI's major version picks the transport. The choice is part of
 * the SDK session identity, so a conversation recorded by one generation is
 * never resumed by the other after an upgrade or downgrade.
 *
 * Detection is best-effort: any probe failure falls back to the 1.x transport,
 * which is what Netcatty shipped before v2 support existed.
 */

const { spawn } = require("node:child_process");
const { prepareCommandForSpawn } = require("../../ai/shellUtils.cjs");

/** Session-identity runtime token for the 1.x in-process SDK transport. */
const OPENCODE_RUNTIME_SDK = "sdk";
/** Session-identity runtime token for the 2.x `opencode serve` transport. */
const OPENCODE_RUNTIME_V2 = "http-v2";
/** First CLI major version served by the HTTP/SSE transport. */
const OPENCODE_V2_MIN_MAJOR = 2;
/** Env override, mirroring NETCATTY_GROK_RUNTIME. */
const OPENCODE_RUNTIME_ENV = "NETCATTY_OPENCODE_RUNTIME";
const OPENCODE_VERSION_PROBE_TIMEOUT_MS = 5000;
const OPENCODE_RUNTIME_CACHE_TTL_MS = 60 * 1000;
const OPENCODE_RUNTIME_CACHE_MAX_ENTRIES = 16;

const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/;

/**
 * Parse a `--version` payload from either CLI generation:
 *   1.x -> "1.19.0"
 *   2.x -> "opencode v2.0.29"
 */
function parseOpenCodeVersion(output) {
  const text = String(output || "");
  const match = VERSION_PATTERN.exec(text);
  if (!match) return null;
  const [version, major, minor, patch] = match;
  return {
    version,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

function resolveOpenCodeRuntimeToken(major) {
  return Number(major) >= OPENCODE_V2_MIN_MAJOR ? OPENCODE_RUNTIME_V2 : OPENCODE_RUNTIME_SDK;
}

/** Accepts `v1`/`sdk`/`1` and `v2`/`http-v2`/`http`/`2`; anything else is ignored. */
function normalizeOpenCodeRuntimeOverride(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "v1" || raw === "sdk" || raw === "1" || raw === "1.x") return OPENCODE_RUNTIME_SDK;
  if (raw === "v2" || raw === "http-v2" || raw === "http" || raw === "2" || raw === "2.x") {
    return OPENCODE_RUNTIME_V2;
  }
  return null;
}

function resolveOpenCodeRuntimeOverride(env, explicit) {
  const direct = normalizeOpenCodeRuntimeOverride(explicit);
  if (direct) return direct;
  return normalizeOpenCodeRuntimeOverride(env?.[OPENCODE_RUNTIME_ENV]);
}

function resolveOpenCodeProbeCommand(binPath, env) {
  const candidates = [binPath, env?.OPENCODE_BIN, "opencode"];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) return value;
  }
  return null;
}

/**
 * Run `<opencode> --version` and classify the CLI generation.
 * Never throws: probe failures resolve to the legacy 1.x transport.
 */
function probeOpenCodeRuntime({ binPath, env, spawnImpl, timeoutMs } = {}) {
  const command = resolveOpenCodeProbeCommand(binPath, env);
  const fallback = {
    runtime: OPENCODE_RUNTIME_SDK,
    version: null,
    major: null,
    detected: false,
    source: "fallback",
  };
  if (!command) return Promise.resolve(fallback);

  return new Promise((resolve) => {
    let settled = false;
    let spec;
    let timer = null;
    try {
      spec = prepareCommandForSpawn(command, ["--version"]);
    } catch {
      resolve(fallback);
      return;
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const spawnFn = spawnImpl || spawn;
    let child;
    try {
      child = spawnFn(spec.command, spec.args, {
        env: env || process.env,
        shell: spec.shell,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve(fallback);
      return;
    }

    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(fallback);
    }, Number(timeoutMs) > 0 ? Number(timeoutMs) : OPENCODE_VERSION_PROBE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    let output = "";
    const onChunk = (chunk) => {
      output += String(chunk);
    };
    child.stdout?.on?.("data", onChunk);
    child.stderr?.on?.("data", onChunk);
    child.on?.("error", () => finish(fallback));
    child.on?.("close", (code) => {
      if (code !== 0) {
        finish(fallback);
        return;
      }
      const parsed = parseOpenCodeVersion(output);
      if (!parsed) {
        finish(fallback);
        return;
      }
      finish({
        runtime: resolveOpenCodeRuntimeToken(parsed.major),
        version: parsed.version,
        major: parsed.major,
        detected: true,
        source: "probe",
      });
    });
  });
}

/**
 * Cached runtime resolver. The version cannot change without the binary
 * changing, so results are memoized per CLI path with a short TTL (an in-place
 * `opencode upgrade` must not be cached forever).
 */
function createOpenCodeRuntimeResolver(options = {}) {
  const cache = new Map();
  const pending = new Map();
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : OPENCODE_RUNTIME_CACHE_TTL_MS;
  const maxEntries = Number(options.cacheMaxEntries) > 0
    ? Number(options.cacheMaxEntries)
    : OPENCODE_RUNTIME_CACHE_MAX_ENTRIES;

  function readCache(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > ttlMs) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  function writeCache(key, value) {
    cache.set(key, { at: Date.now(), value });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  function fallbackValue() {
    return {
      runtime: OPENCODE_RUNTIME_SDK,
      version: null,
      major: null,
      detected: false,
      source: "fallback",
    };
  }

  return {
    async resolve({ binPath, env, requestedRuntime } = {}) {
      const override = resolveOpenCodeRuntimeOverride(env, requestedRuntime);
      if (override) {
        return {
          runtime: override,
          version: null,
          major: null,
          detected: false,
          source: "override",
        };
      }
      const command = resolveOpenCodeProbeCommand(binPath, env);
      if (!command) return fallbackValue();

      const cached = readCache(command);
      if (cached) return cached;

      // Coalesce concurrent probes for the same binary so a burst of turns or
      // list-models calls spawns one version check, not one per caller.
      const inFlight = pending.get(command);
      if (inFlight) return inFlight;

      const probe = probeOpenCodeRuntime({
        binPath: command,
        env,
        spawnImpl: options.spawnImpl,
        timeoutMs: options.timeoutMs,
      }).then((value) => {
        writeCache(command, value);
        return value;
      }).finally(() => {
        pending.delete(command);
      });
      pending.set(command, probe);
      return probe;
    },
    clear() {
      cache.clear();
      pending.clear();
    },
  };
}

const defaultResolver = createOpenCodeRuntimeResolver();

async function resolveOpenCodeRuntime(args) {
  return defaultResolver.resolve(args);
}

function resetOpenCodeRuntimeCache() {
  defaultResolver.clear();
}

module.exports = {
  OPENCODE_RUNTIME_ENV,
  OPENCODE_RUNTIME_SDK,
  OPENCODE_RUNTIME_V2,
  OPENCODE_V2_MIN_MAJOR,
  OPENCODE_RUNTIME_CACHE_TTL_MS,
  createOpenCodeRuntimeResolver,
  normalizeOpenCodeRuntimeOverride,
  parseOpenCodeVersion,
  probeOpenCodeRuntime,
  resetOpenCodeRuntimeCache,
  resolveOpenCodeRuntime,
  resolveOpenCodeRuntimeOverride,
  resolveOpenCodeRuntimeToken,
};
