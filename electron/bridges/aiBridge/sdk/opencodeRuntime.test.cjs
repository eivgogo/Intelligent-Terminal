const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  OPENCODE_RUNTIME_SDK,
  OPENCODE_RUNTIME_V2,
  createOpenCodeRuntimeResolver,
  normalizeOpenCodeRuntimeOverride,
  parseOpenCodeVersion,
  resolveOpenCodeRuntimeOverride,
  resolveOpenCodeRuntimeToken,
} = require("./opencodeRuntime.cjs");

/** Minimal ChildProcess stand-in for `--version` probes. */
function createFakeChild({ stdout = "", stderr = "", code = 0, error = null, delayMs = 0 }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  setTimeout(() => {
    if (error) {
      child.emit("error", error);
      return;
    }
    if (stdout) child.stdout.emit("data", stdout);
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", code);
  }, delayMs);
  return child;
}

function createSpawnRecorder(plan) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const step = plan[Math.min(calls.length, plan.length - 1)];
    calls.push({ command, args, options });
    return createFakeChild(step);
  };
  return { spawnImpl, calls };
}

test("parseOpenCodeVersion reads both CLI generations", () => {
  const v1 = parseOpenCodeVersion("1.19.0\n");
  assert.equal(v1.version, "1.19.0");
  assert.equal(v1.major, 1);
  const v2 = parseOpenCodeVersion("opencode v2.0.29");
  assert.equal(v2.version, "2.0.29");
  assert.equal(v2.major, 2);
  assert.equal(parseOpenCodeVersion("2.1.0-beta-19283").major, 2);
  assert.equal(parseOpenCodeVersion("v10.2.3").major, 10);
  assert.equal(parseOpenCodeVersion("no version here"), null);
  assert.equal(parseOpenCodeVersion(""), null);
});

test("resolveOpenCodeRuntimeToken maps major versions onto transports", () => {
  assert.equal(resolveOpenCodeRuntimeToken(1), OPENCODE_RUNTIME_SDK);
  assert.equal(resolveOpenCodeRuntimeToken(2), OPENCODE_RUNTIME_V2);
  assert.equal(resolveOpenCodeRuntimeToken(3), OPENCODE_RUNTIME_V2);
  assert.equal(resolveOpenCodeRuntimeToken(null), OPENCODE_RUNTIME_SDK);
});

test("normalizeOpenCodeRuntimeOverride accepts both vocabularies", () => {
  assert.equal(normalizeOpenCodeRuntimeOverride("v1"), OPENCODE_RUNTIME_SDK);
  assert.equal(normalizeOpenCodeRuntimeOverride("sdk"), OPENCODE_RUNTIME_SDK);
  assert.equal(normalizeOpenCodeRuntimeOverride("v2"), OPENCODE_RUNTIME_V2);
  assert.equal(normalizeOpenCodeRuntimeOverride("http-v2"), OPENCODE_RUNTIME_V2);
  assert.equal(normalizeOpenCodeRuntimeOverride(" HTTP "), OPENCODE_RUNTIME_V2);
  assert.equal(normalizeOpenCodeRuntimeOverride("nonsense"), null);
  assert.equal(normalizeOpenCodeRuntimeOverride(""), null);
});

test("resolveOpenCodeRuntimeOverride prefers the explicit argument over env", () => {
  assert.equal(
    resolveOpenCodeRuntimeOverride({ NETCATTY_OPENCODE_RUNTIME: "v1" }, "v2"),
    OPENCODE_RUNTIME_V2,
  );
  assert.equal(
    resolveOpenCodeRuntimeOverride({ NETCATTY_OPENCODE_RUNTIME: "v2" }),
    OPENCODE_RUNTIME_V2,
  );
  assert.equal(resolveOpenCodeRuntimeOverride({}), null);
});

test("resolver classifies a 2.x CLI and memoizes the probe", async () => {
  const { spawnImpl, calls } = createSpawnRecorder([{ stdout: "opencode v2.0.29\n" }]);
  const resolver = createOpenCodeRuntimeResolver({ spawnImpl });

  const first = await resolver.resolve({ binPath: "/usr/local/bin/opencode", env: {} });
  assert.equal(first.runtime, OPENCODE_RUNTIME_V2);
  assert.equal(first.version, "2.0.29");
  assert.equal(first.detected, true);
  assert.equal(first.source, "probe");

  const second = await resolver.resolve({ binPath: "/usr/local/bin/opencode", env: {} });
  assert.equal(second.runtime, OPENCODE_RUNTIME_V2);
  assert.equal(calls.length, 1, "cached probes must not respawn");
  assert.deepEqual(calls[0].args, ["--version"]);
});

test("resolver keeps the 1.x transport for older CLIs and probe failures", async () => {
  const v1 = createOpenCodeRuntimeResolver({
    spawnImpl: createSpawnRecorder([{ stdout: "1.19.0\n" }]).spawnImpl,
  });
  assert.equal((await v1.resolve({ binPath: "/opt/opencode", env: {} })).runtime, OPENCODE_RUNTIME_SDK);

  const missing = createOpenCodeRuntimeResolver({
    spawnImpl: createSpawnRecorder([{ error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) }]).spawnImpl,
  });
  const missingResult = await missing.resolve({ binPath: "/opt/opencode", env: {} });
  assert.equal(missingResult.runtime, OPENCODE_RUNTIME_SDK);
  assert.equal(missingResult.detected, false);
  assert.equal(missingResult.source, "fallback");

  const failing = createOpenCodeRuntimeResolver({
    spawnImpl: createSpawnRecorder([{ stdout: "opencode v2.0.1", code: 1 }]).spawnImpl,
  });
  assert.equal((await failing.resolve({ binPath: "/opt/opencode", env: {} })).runtime, OPENCODE_RUNTIME_SDK);

  const garbage = createOpenCodeRuntimeResolver({
    spawnImpl: createSpawnRecorder([{ stdout: "command not found" }]).spawnImpl,
  });
  assert.equal((await garbage.resolve({ binPath: "/opt/opencode", env: {} })).runtime, OPENCODE_RUNTIME_SDK);
});

test("resolver honours the env override without probing", async () => {
  const { spawnImpl, calls } = createSpawnRecorder([{ stdout: "opencode v2.0.29\n" }]);
  const resolver = createOpenCodeRuntimeResolver({ spawnImpl });

  const forced = await resolver.resolve({
    binPath: "/opt/opencode",
    env: { NETCATTY_OPENCODE_RUNTIME: "v1" },
  });
  assert.equal(forced.runtime, OPENCODE_RUNTIME_SDK);
  assert.equal(forced.source, "override");
  assert.equal(calls.length, 0, "an override must not spawn a probe");

  const forcedV2 = await resolver.resolve({
    binPath: "/opt/opencode",
    env: { NETCATTY_OPENCODE_RUNTIME: "v2" },
  });
  assert.equal(forcedV2.runtime, OPENCODE_RUNTIME_V2);
});

test("resolver coalesces concurrent probes for the same binary", async () => {
  const { spawnImpl, calls } = createSpawnRecorder([{ stdout: "opencode v2.0.29\n", delayMs: 10 }]);
  const resolver = createOpenCodeRuntimeResolver({ spawnImpl });

  const [a, b] = await Promise.all([
    resolver.resolve({ binPath: "/opt/opencode", env: {} }),
    resolver.resolve({ binPath: "/opt/opencode", env: {} }),
  ]);
  assert.equal(a.runtime, OPENCODE_RUNTIME_V2);
  assert.equal(b.runtime, OPENCODE_RUNTIME_V2);
  assert.equal(calls.length, 1);
});

test("resolver falls back to the 1.x transport when no CLI is configured", async () => {
  const resolver = createOpenCodeRuntimeResolver({ spawnImpl: () => { throw new Error("must not spawn"); } });
  const result = await resolver.resolve({ binPath: "", env: {} });
  assert.equal(result.runtime, OPENCODE_RUNTIME_SDK);
  assert.equal(result.source, "fallback");
});

test("resolver probes again once the cache TTL lapses", async () => {
  const { spawnImpl, calls } = createSpawnRecorder([{ stdout: "1.19.0" }, { stdout: "opencode v2.0.5" }]);
  const resolver = createOpenCodeRuntimeResolver({ spawnImpl, ttlMs: 1 });
  assert.equal((await resolver.resolve({ binPath: "/opt/opencode", env: {} })).runtime, OPENCODE_RUNTIME_SDK);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await resolver.resolve({ binPath: "/opt/opencode", env: {} })).runtime, OPENCODE_RUNTIME_V2);
  assert.equal(calls.length, 2);
});
