"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CAPABILITY_STATUS } = require("../constants.cjs");
const { ALL_CAPABILITIES } = require("../catalog/index.cjs");
const { TOOL_INPUT_FIELDS } = require("../schemas/toolInputs.cjs");
const {
  listMcpTools,
  AGENT_CAPABILITY_DENYLIST,
  isAgentEligibleForKind,
  AGENT_KINDS,
  listAgentToolSpecs,
} = require("./toolSurfaces.cjs");
const { registerMcpTools, buildZodShapeObject, isEmptyMcpInputShape } = require("./mcpToolRegistry.cjs");

function mcpToolHandler(schemaOrHandler, maybeHandler) {
  return typeof schemaOrHandler === "function" ? schemaOrHandler : maybeHandler;
}

test("global agent tool specs include terminal long-running tools", () => {
  const specs = listAgentToolSpecs(AGENT_KINDS.GLOBAL);
  const names = specs.map((spec) => spec.toolName);
  assert.ok(names.includes("terminal_execute"));
  assert.ok(names.includes("terminal_start"));
  assert.ok(names.includes("terminal_poll"));
  assert.ok(names.includes("terminal_stop"));
});

test("global agent tool specs include SFTP write tools and attachments", () => {
  const capabilityIds = listAgentToolSpecs(AGENT_KINDS.GLOBAL).map((spec) => spec.capabilityId);
  assert.ok(capabilityIds.includes("attachment.list"));
  assert.ok(capabilityIds.includes("attachment.read"));
  assert.ok(capabilityIds.includes("sftp.write"));
  assert.ok(capabilityIds.includes("sftp.mkdir"));
  assert.ok(capabilityIds.includes("sftp.delete"));
  assert.ok(capabilityIds.includes("sftp.rename"));
  assert.ok(capabilityIds.includes("sftp.chmod"));
  assert.ok(!capabilityIds.includes("meta.status"));
  assert.ok(!capabilityIds.includes("session.cancel"));
});

test("global agent tool specs include vault host tools and SFTP transfer", () => {
  const capabilityIds = listAgentToolSpecs(AGENT_KINDS.GLOBAL).map((spec) => spec.capabilityId);
  assert.ok(capabilityIds.includes("vault.host.get"));
  assert.ok(capabilityIds.includes("vault.host.list"));
  assert.ok(capabilityIds.includes("vault.host.open"));
  assert.ok(capabilityIds.includes("vault.hosts.create"));
  assert.ok(capabilityIds.includes("vault.host.update"));
  assert.ok(capabilityIds.includes("vault.host.delete"));
  assert.ok(capabilityIds.includes("vault.host.import"));
  assert.ok(capabilityIds.includes("vault.note.create"));
  assert.ok(capabilityIds.includes("vault.note.list"));
  assert.ok(capabilityIds.includes("sftp.download"));
  assert.ok(capabilityIds.includes("sftp.upload"));
});

test("host_open stays on MCP and the global agent", () => {
  const globalIds = listAgentToolSpecs(AGENT_KINDS.GLOBAL).map((spec) => spec.capabilityId);
  const mcpHostOpen = listMcpTools().find((tool) => tool.mcpTool === "host_open");

  assert.ok(globalIds.includes("vault.host.open"));
  assert.ok(mcpHostOpen);
  assert.equal(mcpHostOpen.capabilityId, "vault.host.open");
});

test("listMcpTools includes vault host update and delete for external MCP clients", () => {
  const tools = listMcpTools();
  const create = tools.find((tool) => tool.mcpTool === "vault_hosts_create");
  const update = tools.find((tool) => tool.mcpTool === "vault_hosts_update");
  const remove = tools.find((tool) => tool.mcpTool === "vault_hosts_delete");
  assert.match(create?.inputShape.hosts?.description ?? "", /passphrase/i);
  assert.equal(update?.capabilityId, "vault.host.update");
  assert.equal(update?.publicRpcMethod, "public/vault/hosts/update");
  assert.ok(update?.inputShape.keyPath);
  assert.ok(update?.inputShape.keypath);
  assert.ok(update?.inputShape.savePassword);
  assert.ok(update?.inputShape.passphrase);
  assert.equal(remove?.capabilityId, "vault.host.delete");
  assert.equal(remove?.publicRpcMethod, "public/vault/hosts/delete");
});

test("listMcpTools includes host_open for external MCP clients", () => {
  const tools = listMcpTools();
  const hostOpen = tools.find((tool) => tool.mcpTool === "host_open");
  assert.ok(hostOpen);
  assert.equal(hostOpen.capabilityId, "vault.host.open");
  assert.equal(hostOpen.publicRpcMethod, "public/vault/hosts/open");
});

test("session_close is exposed to agents and external MCP clients", () => {
  const mcpTool = listMcpTools().find((tool) => tool.mcpTool === "session_close");
  assert.ok(mcpTool);
  assert.equal(mcpTool.capabilityId, "session.close");
  assert.equal(mcpTool.publicRpcMethod, "public/session/close");

  const agentTool = listAgentToolSpecs(AGENT_KINDS.GLOBAL).find((tool) => tool.toolName === "session_close");
  assert.ok(agentTool);
  assert.equal(agentTool.rpcMethod, "session/close");
});

test("host_open tells agents to close sessions after use", () => {
  const hostOpen = listMcpTools().find((tool) => tool.mcpTool === "host_open");
  assert.match(hostOpen?.description || "", /session_close/i);
});

test("vault host import tool description routes unknown attached host text to host creation", () => {
  const importSpec = listAgentToolSpecs(AGENT_KINDS.GLOBAL).find((spec) => spec.capabilityId === "vault.host.import");
  assert.ok(importSpec);
  assert.match(importSpec.description, /known export formats/i);
  assert.match(importSpec.description, /unknown/i);
  assert.match(importSpec.description, /read_attachment/i);
  assert.match(importSpec.description, /vault_hosts_create/i);
});

test("global agent binds vault note tools to global RPC methods", () => {
  const specs = listAgentToolSpecs(AGENT_KINDS.GLOBAL);
  const noteCreate = specs.find((spec) => spec.capabilityId === "vault.note.create");
  assert.equal(noteCreate?.rpcMethod, "vault/notes/create");
  const noteList = specs.find((spec) => spec.capabilityId === "vault.note.list");
  assert.equal(noteList?.rpcMethod, "vault/notes/list");
});

test("global agent binds vault and portforward tools to global RPC methods", () => {
  const specs = listAgentToolSpecs(AGENT_KINDS.GLOBAL);
  const hostNotesSet = specs.find((spec) => spec.capabilityId === "vault.host.notes.set");
  assert.equal(hostNotesSet?.rpcMethod, "vault/host/notes/set");
  const portforwardStart = specs.find((spec) => spec.capabilityId === "portforward.start");
  assert.equal(portforwardStart?.rpcMethod, "portforward/start");
});

test("generic snippet agent tools expose dynamic group targets", () => {
  const specs = listAgentToolSpecs(AGENT_KINDS.GLOBAL);
  for (const capabilityId of ["vault.snippets.create", "vault.snippets.update"]) {
    const spec = specs.find((entry) => entry.capabilityId === capabilityId);
    assert.ok(spec, `${capabilityId} should be exposed to ${AGENT_KINDS.GLOBAL}`);
    assert.match(spec.inputShape.targetGroups?.description ?? "", /group paths/i);
  }
});

test("harness capabilities are not exposed on MCP", () => {
  const mcpCapabilityIds = listMcpTools().map((tool) => tool.capabilityId);
  for (const capabilityId of mcpCapabilityIds) {
    assert.ok(!capabilityId.startsWith("harness."));
  }
});

test("listMcpTools descriptions stay aligned with catalog capability ids", () => {
  const mcpTools = listMcpTools();
  assert.ok(mcpTools.length >= 35);
  for (const tool of mcpTools) {
    assert.ok(tool.capabilityId);
    assert.ok(tool.mcpTool);
    assert.ok(tool.description.length > 0);
    assert.ok(tool.rpcMethod);
  }
});

test("agent and mcp terminal tools share capability ids", () => {
  const agent = listAgentToolSpecs(AGENT_KINDS.GLOBAL).find((spec) => spec.toolName === "terminal_execute");
  const mcp = listMcpTools().find((tool) => tool.mcpTool === "terminal_execute");
  assert.equal(agent?.capabilityId, "terminal.execute");
  assert.equal(mcp?.capabilityId, "terminal.execute");
});

test("implemented catalog tools with inputs are agent-eligible unless denylisted or agentKinds-restricted", () => {
  const implemented = ALL_CAPABILITIES.filter((cap) => cap.status === CAPABILITY_STATUS.IMPLEMENTED);
  for (const capability of implemented) {
    const hasInputs = Object.prototype.hasOwnProperty.call(TOOL_INPUT_FIELDS, capability.id);
    if (!hasInputs) continue;
    if (AGENT_CAPABILITY_DENYLIST.has(capability.id)) {
      assert.equal(isAgentEligibleForKind(capability, AGENT_KINDS.GLOBAL), false);
      continue;
    }
    if (Array.isArray(capability.agentKinds) && capability.agentKinds.length > 0
      && !capability.agentKinds.includes(AGENT_KINDS.GLOBAL)) {
      assert.equal(isAgentEligibleForKind(capability, AGENT_KINDS.GLOBAL), false);
      continue;
    }
    const hasRpc = Boolean(
      capability.surfaces?.builtin?.rpcMethod
      || capability.surfaces?.public?.mcpTool,
    );
    if (hasRpc) {
      assert.equal(isAgentEligibleForKind(capability, AGENT_KINDS.GLOBAL), true);
    }
  }
});


test("mcp registry builds zod shapes for every MCP tool", () => {
  for (const tool of listMcpTools()) {
    const shape = buildZodShapeObject(tool.inputShape);
    assert.equal(typeof shape, "object");
  }
});

test("registerMcpTools registers one handler per catalog MCP tool", () => {
  const registered = [];
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      registered.push({ name, handler: typeof mcpToolHandler(schemaOrHandler, maybeHandler) });
    },
  };
  const count = registerMcpTools(fakeServer, {
    rpcCall: async () => ({ ok: true }),
    scopeParams: {},
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  });
  assert.equal(count, listMcpTools().length);
  assert.equal(registered.length, listMcpTools().length);
});

test("no-arg MCP tools register without a params schema so omitted arguments are valid (#3049)", () => {
  const registrations = [];
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      registrations.push({
        name,
        hasSchema: typeof schemaOrHandler !== "function",
        handler: mcpToolHandler(schemaOrHandler, maybeHandler),
      });
    },
  };
  registerMcpTools(fakeServer, {
    rpcCall: async () => ({ ok: true }),
    scopeParams: {},
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  });

  const noArgNames = listMcpTools()
    .filter((tool) => isEmptyMcpInputShape(tool.inputShape))
    .map((tool) => tool.mcpTool);
  assert.ok(noArgNames.includes("get_environment"));
  assert.ok(noArgNames.includes("list_attachments"));

  for (const name of noArgNames) {
    const registration = registrations.find((entry) => entry.name === name);
    assert.equal(registration?.hasSchema, false, `${name} should omit the params schema`);
  }

  const execute = registrations.find((entry) => entry.name === "terminal_execute");
  assert.equal(execute?.hasSchema, true);
});

test("get_environment handler runs when MCP arguments are omitted (#3049)", async () => {
  let handler = null;
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      if (name === "get_environment") handler = mcpToolHandler(schemaOrHandler, maybeHandler);
    },
  };
  let rpcMethod = null;
  registerMcpTools(fakeServer, {
    rpcCall: async (method) => {
      rpcMethod = method;
      return { sessions: [] };
    },
    scopeParams: { chatSessionId: "chat-1" },
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  });

  assert.ok(handler, "get_environment handler registered");
  const result = await handler();
  assert.equal(result.isError, undefined);
  assert.equal(rpcMethod, "netcatty/getContext");
  assert.match(result.content?.[0]?.text || "", /sessions/);
});

test("session_close remains available as a cleanup action in observer mode", async () => {
  let handler = null;
  let guardCalls = 0;
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      if (name === "session_close") handler = mcpToolHandler(schemaOrHandler, maybeHandler);
    },
  };
  registerMcpTools(fakeServer, {
    rpcCall: async (_method, params) => ({ ok: true, sessionId: params.sessionId, status: "closed" }),
    scopeParams: { chatSessionId: "chat-1" },
    guardWriteOperation: () => {
      guardCalls += 1;
      return "Observer mode";
    },
    catalogDescription: (_name, fallback) => fallback,
  });

  const result = await handler({ sessionId: "session-1" });
  assert.equal(result.isError, undefined);
  assert.equal(guardCalls, 0);
});

test("terminal_execute MCP response preserves stdout/exitCode on non-zero exit (#2718)", async () => {
  let handler = null;
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      if (name === "terminal_execute") handler = mcpToolHandler(schemaOrHandler, maybeHandler);
    },
  };
  registerMcpTools(fakeServer, {
    rpcCall: async () => ({
      ok: false,
      stdout: "du: cannot access '/missing': No such file or directory",
      stderr: "",
      exitCode: 1,
    }),
    scopeParams: { chatSessionId: "chat-1" },
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  });

  assert.ok(handler, "terminal_execute handler registered");
  const result = await handler({ sessionId: "sess-1", command: "du /missing" });
  assert.equal(result.isError, undefined);
  const text = result.content?.[0]?.text || "";
  assert.match(text, /cannot access '\/missing'/);
  assert.match(text, /\[exit code: 1\]/);
  assert.doesNotMatch(text, /Operation failed/);
});

test("terminal_execute MCP response keeps operational failures as isError", async () => {
  let handler = null;
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      if (name === "terminal_execute") handler = mcpToolHandler(schemaOrHandler, maybeHandler);
    },
  };
  registerMcpTools(fakeServer, {
    rpcCall: async () => ({ ok: false, error: "Session not found" }),
    scopeParams: { chatSessionId: "chat-1" },
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  });

  const result = await handler({ sessionId: "gone", command: "uptime" });
  assert.equal(result.isError, true);
  assert.equal(result.content?.[0]?.text, "Error: Session not found");
});

test("terminal_execute MCP response includes partial output on timeout", async () => {
  let handler = null;
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      if (name === "terminal_execute") handler = mcpToolHandler(schemaOrHandler, maybeHandler);
    },
  };
  registerMcpTools(fakeServer, {
    rpcCall: async () => ({
      ok: false,
      stdout: "partial lines",
      stderr: "",
      exitCode: -1,
      error: "Command timed out (60s)",
    }),
    scopeParams: { chatSessionId: "chat-1" },
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  });

  const result = await handler({ sessionId: "sess-1", command: "sleep 999" });
  assert.equal(result.isError, true);
  const text = result.content?.[0]?.text || "";
  assert.match(text, /partial lines/);
  assert.match(text, /\[exit code: -1\]/);
  assert.match(text, /\[error\] Command timed out \(60s\)/);
});

test("terminal_execute MCP response uses neutral text for successful empty output (#2724)", async () => {
  let handler = null;
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      if (name === "terminal_execute") handler = mcpToolHandler(schemaOrHandler, maybeHandler);
    },
  };
  // Serial/network-device raw PTY success: ok true, empty streams, exitCode null.
  registerMcpTools(fakeServer, {
    rpcCall: async () => ({
      ok: true,
      stdout: "",
      stderr: "",
      exitCode: null,
    }),
    scopeParams: { chatSessionId: "chat-1" },
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  });

  const result = await handler({ sessionId: "sess-1", command: "configure terminal" });
  assert.equal(result.isError, undefined);
  assert.equal(result.content?.[0]?.text, "Command completed (no output)");
  assert.doesNotMatch(result.content?.[0]?.text || "", /Operation failed/);
});

test("terminal_execute MCP response keeps exit-only non-zero without isError", async () => {
  let handler = null;
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      if (name === "terminal_execute") handler = mcpToolHandler(schemaOrHandler, maybeHandler);
    },
  };
  registerMcpTools(fakeServer, {
    rpcCall: async () => ({
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: 1,
    }),
    scopeParams: { chatSessionId: "chat-1" },
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  });

  const result = await handler({ sessionId: "sess-1", command: "false" });
  assert.equal(result.isError, undefined);
  assert.equal(result.content?.[0]?.text, "[exit code: 1]");
  assert.doesNotMatch(result.content?.[0]?.text || "", /Operation failed/);
});
