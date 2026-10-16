"use strict";

const { AGENT_KINDS, CAPABILITY_STATUS, CAPABILITY_SURFACES } = require("../constants.cjs");
const { ALL_CAPABILITIES } = require("../catalog/index.cjs");
const { TOOL_INPUT_FIELDS, MODEL_DESCRIPTION_HINTS } = require("../schemas/toolInputs.cjs");

function buildZodShape(fields) {
  const shape = {};
  for (const [key, field] of Object.entries(fields || {})) {
    shape[key] = {
      type: field.type,
      optional: Boolean(field.optional),
      description: field.description || "",
    };
  }
  return shape;
}

function getMcpToolName(capability) {
  return capability.surfaces?.public?.mcpTool
    || capability.surfaces?.builtin?.mcpTool
    || null;
}

function getAgentToolName(capability, agentKind) {
  if (agentKind === AGENT_KINDS.GLOBAL) {
    return capability.surfaces?.[CAPABILITY_SURFACES.GLOBAL_AGENT]?.toolName
      || getMcpToolName(capability)
      || capability.id.replace(/\./g, "_");
  }
  return getMcpToolName(capability) || capability.id.replace(/\./g, "_");
}

function getAgentRpcMethod(capability) {
  return capability.surfaces?.builtin?.rpcMethod
    || capability.surfaces?.global?.rpcMethod
    || capability.surfaces?.public?.rpcMethod
    || null;
}

function buildToolDescription(capability) {
  const hint = MODEL_DESCRIPTION_HINTS[capability.id];
  if (!hint) return capability.description;
  return `${capability.description} ${hint}`;
}

function listToolSurfaces(options = {}) {
  const {
    surface = CAPABILITY_SURFACES.PUBLIC,
    status = CAPABILITY_STATUS.IMPLEMENTED,
  } = options;

  const tools = [];

  for (const capability of ALL_CAPABILITIES) {
    if (capability.status !== status) continue;
    const binding = capability.surfaces?.[surface] || capability.surfaces?.public || capability.surfaces?.builtin;
    if (!binding) continue;

    const mcpTool = getMcpToolName(capability);
    const toolName = mcpTool || capability.id.replace(/\./g, "_");

    const builtinRpc = capability.surfaces?.builtin?.rpcMethod || binding.rpcMethod || null;

    tools.push({
      capabilityId: capability.id,
      domain: capability.domain,
      toolName,
      mcpTool,
      rpcMethod: builtinRpc,
      publicRpcMethod: capability.surfaces?.public?.rpcMethod || null,
      description: buildToolDescription(capability),
      policy: capability.policy,
      inputShape: buildZodShape(TOOL_INPUT_FIELDS[capability.id]),
    });
  }

  return tools;
}

function listMcpTools() {
  return listToolSurfaces({ surface: CAPABILITY_SURFACES.PUBLIC })
    .filter((tool) => tool.mcpTool);
}

/** Capabilities excluded from the in-app agent even when implemented (CLI-only / meta). */
const AGENT_CAPABILITY_DENYLIST = new Set([
  "meta.status",
  "session.cancel",
  "session.resume",
  "session.get",
]);

function isAgentLocalOnlyCapability(capability, agentKind) {
  if (agentKind === AGENT_KINDS.GLOBAL) {
    return Boolean(capability.surfaces?.[CAPABILITY_SURFACES.GLOBAL_AGENT]?.toolName)
      && !getAgentRpcMethod(capability)
      && !getMcpToolName(capability);
  }
  return false;
}

/**
 * Resolve which agents may use a capability when agentKinds is not set explicitly.
 * - surfaces.globalAgent only → global agent
 * - RPC/MCP-backed tools → both agents (shared infrastructure)
 */
function resolveAgentKinds(capability) {
  if (Array.isArray(capability.agentKinds) && capability.agentKinds.length > 0) {
    return capability.agentKinds;
  }
  if (capability.surfaces?.[CAPABILITY_SURFACES.GLOBAL_AGENT]) {
    return [AGENT_KINDS.GLOBAL];
  }
  if (isAgentEligibleForKind(capability, AGENT_KINDS.GLOBAL, { skipAgentKindCheck: true })) {
    return [AGENT_KINDS.GLOBAL];
  }
  return [];
}

function isAgentEligibleForKind(capability, agentKind, options = {}) {
  if (capability.status !== CAPABILITY_STATUS.IMPLEMENTED) return false;
  if (AGENT_CAPABILITY_DENYLIST.has(capability.id)) return false;
  if (!options.skipAgentKindCheck && !resolveAgentKinds(capability).includes(agentKind)) {
    return false;
  }
  const hasInputFields = Object.prototype.hasOwnProperty.call(TOOL_INPUT_FIELDS, capability.id);
  if (!hasInputFields) return false;
  if (isAgentLocalOnlyCapability(capability, agentKind)) return true;
  const hasBuiltinRpc = Boolean(capability.surfaces?.builtin?.rpcMethod);
  const hasGlobalRpc = Boolean(capability.surfaces?.global?.rpcMethod);
  return hasBuiltinRpc || hasGlobalRpc || Boolean(getMcpToolName(capability));
}

function listAgentToolSpecs(agentKind = AGENT_KINDS.GLOBAL) {
  return ALL_CAPABILITIES
    .filter((capability) => isAgentEligibleForKind(capability, agentKind))
    .map((capability) => ({
      capabilityId: capability.id,
      toolName: getAgentToolName(capability, agentKind),
      rpcMethod: getAgentRpcMethod(capability),
      localExecution: isAgentLocalOnlyCapability(capability, agentKind),
      description: buildToolDescription(capability),
      inputShape: buildZodShape(TOOL_INPUT_FIELDS[capability.id]),
      policy: capability.policy,
      agentKind,
    }));
}

module.exports = {
  AGENT_KINDS,
  buildZodShape,
  buildToolDescription,
  AGENT_CAPABILITY_DENYLIST,
  getAgentRpcMethod,
  getAgentToolName,
  isAgentEligibleForKind,
  isAgentLocalOnlyCapability,
  listAgentToolSpecs,
  listToolSurfaces,
  listMcpTools,
  resolveAgentKinds,
};
