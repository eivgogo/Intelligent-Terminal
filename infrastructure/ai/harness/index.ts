export type {
  AgentBackend,
  AgentEvent,
  AgentEventListener,
  AgentEventType,
  ApprovalOutcome,
  CompactionEvent,
  CompactionTrace,
  ContextPrepareResult,
  ContextPrepareTrigger,
  ExternalBridgeHistoryMessage,
  TokenEstimatorKind,
  UsageEvent,
  PerformanceEvent,
  ModelCallStartEvent,
  StepEndEvent,
} from './types';
export type {
  TurnSteerFailureReason,
  TurnSteerInput,
  TurnSteerResult,
} from './turnDrivers/types';

export { TraceStore, globalTraceStore } from './traceStore';
export type { TraceExport } from './traceStore';

export { stopAgentTurn, clearChatSessionCancelled } from './agentStop';
export type { AgentStopBridge, StopAgentTurnParams, StopAgentTurnReason } from './agentStop';

export { AgentRuntime } from './agentRuntime';
export { globalAgentRuntime, getAgentRuntime } from './globalAgentRuntime';

export {
  estimateModelMessagesTokens,
  estimateModelMessagesTokensWithKind,
  estimateTextTokens,
  estimateUnknownTokens,
} from './tokenEstimator';
export type { EstimateModelMessagesTokensInput, EstimateModelMessagesTokensResult } from './tokenEstimator';

export { ToolOutputStore, globalToolOutputStore } from './toolOutputStore';
export type {
  ToolOutputHandle,
  StoreToolOutputInput,
  ReadToolOutputInput,
  ToolOutputReadResult,
  ToolOutputPersistence,
  ToolOutputStoreOptions,
} from './toolOutputStore';

export { ToolResultDedup, hashScopeKey, previewToolResult } from './toolResultDedup';
export type { ToolResultDedupEntry } from './toolResultDedup';

export { externalSdkTurnDriver } from './turnDrivers/externalSdkTurnDriver';
export type {
  TurnInput,
  TurnResult,
  TurnDriver,
  TurnDriverContext,
  TurnUiCallbacks,
  ExternalTurnInput,
} from './turnDrivers/types';

export {
  prepareTurnContext,
  buildExternalBridgeContext,
  extractLatestUserGoal,
} from './contextManager';
export type { PrepareTurnContextInput, PostCompactReinjection } from './contextManager';

export {
  computeCompactionThreshold,
  computeTotalInputTokens,
  shouldCompactByBudget,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from './contextBudget';

export { SessionStateStore, globalSessionStateStore } from './sessionState';
export type { CattySessionState } from './sessionState';

export { repairToolMessageIntegrity } from './toolMessageIntegrity';
export { redactSecretsForModel } from './modelSecretRedaction';
export { buildPromptContextSnapshot } from './promptContextSnapshot';
export type { PromptContextSnapshot } from './promptContextSnapshot';

export { pruneStaleToolContext } from './staleContextPruner';
export { pruneUntilFitsCompaction } from './compactionPruner';

export { buildExternalBridgeContextMessages } from './externalBridgeContext';

export {
  encodeSdkSessionIdentity,
  parseSdkSessionIdentity,
  SDK_SESSION_ID_PREFIX,
} from './sdkSessionIdentity';
export type { SdkSessionIdentityPayload } from './sdkSessionIdentity';

export {
  mapSdkStreamEventToAgentEvents,
  createHarnessEventSink,
} from './agentEventAdapter';
export type { StreamEventContext } from './agentEventAdapter';

export {
  PermissionGrantStore,
  buildGrantFromApproval,
  createPermissionGrantId,
  getActivePermissionGrants,
  matchPermissionGrant,
  patternMatches,
  resolveCapabilityId,
  sanitizePermissionGrants,
  setActivePermissionGrants,
} from './permissionGrants';
export type { PermissionGrantMatchContext, PermissionGrantRule } from './permissionGrants';
