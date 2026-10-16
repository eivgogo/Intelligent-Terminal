import type {
  AIPermissionMode,
  AIToolIntegrationMode,
  AISession,
  ChatMessage,
  ChatMessageAttachment,
  ExternalAgentConfig,
  ProviderConfig,
} from '../../types';
import type { AgentBackend, AgentEvent, AgentEventListener } from '../types';
import type { ToolOutputStore } from '../toolOutputStore';
import type { ToolResultDedup } from '../toolResultDedup';
import type { SessionStateStore } from '../sessionState';
import type { DefaultTargetSessionHint } from '../../sdkAgentAdapter';

export interface TerminalSessionInfo {
  sessionId: string;
  hostId?: string;
  hostname: string;
  label: string;
  os?: string;
  username?: string;
  protocol?: string;
  shellType?: string;
  deviceType?: string;
  connected: boolean;
  hostChain?: Array<{ hostId: string; label?: string; hostname?: string }>;
  activePortForwards?: Array<{
    ruleId: string;
    label?: string;
    type?: string;
    localPort?: number;
    status?: string;
  }>;
}

export interface TurnUiCallbacks {
  addMessageToSession: (sessionId: string, message: ChatMessage) => void;
  updateLastMessage: (sessionId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  updateMessageById: (sessionId: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  reportStreamError: (sessionId: string, abortSignal: AbortSignal, err: unknown) => void;
  setStreamingForScope: (key: string, val: boolean) => void;
  getLatestSession?: (sessionId: string) => AISession | undefined;
  persistContextCompaction?: (
    sessionId: string,
    compaction: import('../../types').AISessionContextCompaction,
  ) => void;
}

export interface ExternalTurnContext {
  existingSessionId?: string;
  updateExternalSessionId?: (sessionId: string, externalSessionId: string | undefined) => void;
  historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  terminalSessions: TerminalSessionInfo[];
  defaultTargetSession?: DefaultTargetSessionHint;
  providers: ProviderConfig[];
  selectedAgentModel?: string;
  toolIntegrationMode: AIToolIntegrationMode;
  selectedUserSkillSlugs?: string[];
  permissionMode: AIPermissionMode;
}

export interface ExternalTurnInput {
  backend: 'external-sdk';
  chatSessionId: string;
  assistantMsgId: string;
  userText: string;
  signal: AbortSignal;
  agentConfig: ExternalAgentConfig;
  attachedImages: Array<{ base64Data: string; mediaType: string; filename?: string; filePath?: string }>;
  context: ExternalTurnContext;
  bridge?: Record<string, (...args: unknown[]) => unknown> | null;
  ui: TurnUiCallbacks;
}

export type TurnInput = ExternalTurnInput;

export interface TurnResult {
  turnId: string;
  reason: 'completed' | 'aborted' | 'error';
}

export type TurnSteerFailureReason =
  | 'not-steerable'
  | 'busy'
  | 'inactive'
  | 'unsupported'
  | 'cancelled'
  | 'failed';

export type TurnSteerResult =
  | { status: 'accepted'; assistantMessageId: string }
  | {
      status: TurnSteerFailureReason;
      message?: string;
      turnKind?: 'review' | 'compact';
    };

export interface TurnSteerInput {
  chatSessionId: string;
  userMessageId: string;
  userText: string;
  prompt: string;
  attachments?: ChatMessageAttachment[];
  attachedImages: Array<{
    base64Data: string;
    mediaType: string;
    filename?: string;
    filePath?: string;
  }>;
}

export interface TurnDriverContext {
  turnId: string;
  chatSessionId: string;
  sessionId: string;
  backend: AgentBackend;
  signal: AbortSignal;
  emit: (event: Omit<AgentEvent, 'turnId' | 'sessionId' | 'chatSessionId' | 'backend' | 'timestamp'> & Partial<Pick<AgentEvent, 'turnId' | 'sessionId' | 'chatSessionId' | 'backend' | 'timestamp'>>) => void;
  toolOutputStore: ToolOutputStore;
  toolResultDedup: ToolResultDedup;
  sessionStateStore: SessionStateStore;
  onEvent?: AgentEventListener;
}

export interface TurnDriver {
  readonly backend: AgentBackend;
  run(input: TurnInput, ctx: TurnDriverContext): Promise<void>;
  steer?(input: TurnSteerInput): Promise<TurnSteerResult>;
  abort?(chatSessionId: string): void;
}
