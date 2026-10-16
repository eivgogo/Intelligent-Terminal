/**
 * Shared types for AI settings sub-components
 */
import type {
  ExternalAgentConfig,
} from "../../../../infrastructure/ai/types";

export type CodexIntegrationState =
  | "connected_chatgpt"
  | "connected_api_key"
  | "connected_custom_config"
  | "not_logged_in"
  | "unknown";

export interface CodexCustomProviderConfig {
  providerName: string;
  displayName: string;
  baseUrl: string | null;
  envKey: string | null;
  envKeyPresent: boolean;
  hasHardcodedApiKey: boolean;
  model: string | null;
  authHash: string | null;
}

export interface CodexIntegrationStatus {
  state: CodexIntegrationState;
  isConnected: boolean;
  rawOutput: string;
  exitCode: number | null;
  customConfig?: CodexCustomProviderConfig | null;
}

export interface CodexAppServerStatus {
  available: boolean;
  checking?: boolean;
  error?: string;
}

export type CodexLoginState = "running" | "success" | "error" | "cancelled";

export interface CodexLoginSession {
  sessionId: string;
  state: CodexLoginState;
  url: string | null;
  output: string;
  error: string | null;
  exitCode: number | null;
  codexPath?: string | null;
}

export interface AgentPathInfo {
  path: string | null;
  binPath?: string | null;
  version: string | null;
  available: boolean;
  installed?: boolean;
  authenticated?: boolean;
  authSource?: string | null;
  cliEmail?: string | null;
  cliBinPath?: string | null;
  /** True when local Cursor Agent CLI is logged in (subscription session). */
  cliLoginOk?: boolean;
  /** True when settings or env API key is present. */
  apiKeyOk?: boolean;
  /** True when @cursor/sdk platform package is importable. */
  sdkInstalled?: boolean;
}

/** Mode-aware Cursor availability for Settings enablement. */
export function isCursorAvailableForMode(
  pathInfo: AgentPathInfo | null | undefined,
  mode: "api-key" | "cli-login",
  options?: { hasStoredApiKey?: boolean },
): boolean {
  if (!pathInfo) return false;
  if (mode === "cli-login") {
    return Boolean(pathInfo.cliLoginOk || pathInfo.authSource === "cli-login");
  }
  const hasKey = Boolean(
    options?.hasStoredApiKey
    || pathInfo.apiKeyOk
    || pathInfo.authSource === "settings"
    || pathInfo.authSource === "CURSOR_API_KEY",
  );
  const sdkOk = pathInfo.sdkInstalled !== undefined
    ? Boolean(pathInfo.sdkInstalled)
    : Boolean(pathInfo.installed);
  return hasKey && sdkOk;
}

export interface UserSkillStatusItem {
  id: string;
  slug: string;
  directoryName: string;
  directoryPath: string;
  skillPath: string;
  name: string;
  description: string;
  status: "ready" | "warning";
  warnings: string[];
}

export interface UserSkillsStatusResult {
  ok: boolean;
  directoryPath?: string;
  readyCount?: number;
  warningCount?: number;
  skills?: UserSkillStatusItem[];
  warnings?: string[];
  error?: string;
}

export interface NetcattyAiBridge {
  aiDiscoverAgents?: (options?: { refreshShellEnv?: boolean; apiKeyPresent?: boolean }) => Promise<Array<AgentPathInfo & { command: string }>>;
  aiPrewarmShellEnv?: () => Promise<{ ok: boolean; error?: string }>;
  aiCodexGetIntegration?: (options?: { refreshShellEnv?: boolean; validateChatGptAuth?: boolean; codexPath?: string }) => Promise<CodexIntegrationStatus>;
  aiCodexStartLogin?: (options?: { codexPath?: string }) => Promise<{ ok: boolean; session?: CodexLoginSession; error?: string }>;
  aiCodexGetLoginSession?: (sessionId: string) => Promise<{ ok: boolean; session?: CodexLoginSession; error?: string }>;
  aiCodexCancelLogin?: (sessionId: string) => Promise<{ ok: boolean; found?: boolean; session?: CodexLoginSession; error?: string }>;
  aiCodexLogout?: (options?: { codexPath?: string }) => Promise<{ ok: boolean; state?: CodexIntegrationState; isConnected?: boolean; rawOutput?: string; logoutOutput?: string; error?: string }>;
  aiResolveCli?: (params: { command: string; customPath?: string; refreshShellEnv?: boolean; apiKeyPresent?: boolean }) => Promise<AgentPathInfo>;
  aiSdkAgentListModels?: (sdkBackend: string, cwd?: string, providerId?: string, chatSessionId?: string, agentEnv?: Record<string, string>, agentCommand?: string, codexRuntime?: 'sdk' | 'app-server') => Promise<{ ok: boolean; models?: Array<{ id: string; name: string; description?: string; thinkingLevels?: string[]; defaultThinkingLevel?: string }>; currentModelId?: string | null; error?: string }>;
  codexAppServerGetStatus?: (agentCommand?: string, agentEnv?: Record<string, string>) => Promise<{ ok: boolean; available: boolean; error?: string }>;
  aiUserSkillsGetStatus?: () => Promise<UserSkillsStatusResult>;
  aiUserSkillsOpenFolder?: () => Promise<UserSkillsStatusResult>;
  openExternal?: (url: string) => Promise<void>;
  externalMcpGetStatus?: () => Promise<Record<string, unknown>>;
  externalMcpSetEnabled?: (enabled: boolean) => Promise<Record<string, unknown>>;
  externalMcpSetConfig?: (config: {
    mode?: 'temporary' | 'persistent';
    idleTimeoutMinutes?: number;
    sessionIdleTimeoutMinutes?: number;
  }) => Promise<Record<string, unknown>>;
  externalMcpCodexGetStatus?: () => Promise<Record<string, unknown>>;
  externalMcpCodexAdd?: () => Promise<Record<string, unknown>>;
  externalMcpClaudeGetStatus?: () => Promise<Record<string, unknown>>;
  externalMcpClaudeAdd?: () => Promise<Record<string, unknown>>;
  externalMcpGrokGetStatus?: () => Promise<Record<string, unknown>>;
  externalMcpGrokAdd?: () => Promise<Record<string, unknown>>;
}

// Agent default configs for registration in externalAgents
export const AGENT_DEFAULTS: Record<string, Omit<ExternalAgentConfig, "id" | "command" | "enabled">> = {
  codex: {
    name: "Codex CLI",
    args: ["exec", "--full-auto", "--json", "{prompt}"],
    icon: "openai",
    sdkBackend: "codex",
  },
  claude: {
    name: "Claude Code",
    args: ["-p", "--output-format", "text", "{prompt}"],
    icon: "claude",
    sdkBackend: "claude",
  },
  copilot: {
    name: "GitHub Copilot CLI",
    args: ["-p", "{prompt}"],
    icon: "copilot",
    sdkBackend: "copilot",
  },
  cursor: {
    name: "Cursor",
    args: ["{prompt}"],
    icon: "cursor",
    sdkBackend: "cursor",
  },
  codebuddy: {
    name: "CodeBuddy Code",
    args: [],
    icon: "codebuddy",
    sdkBackend: "codebuddy",
  },
  opencode: {
    name: "OpenCode",
    args: [],
    icon: "opencode",
    sdkBackend: "opencode",
  },
  grok: {
    name: "Grok Build",
    args: [],
    icon: "grok",
    sdkBackend: "grok",
  },
};

// ---------------------------------------------------------------------------
// Bridge helpers
// ---------------------------------------------------------------------------

export function getBridge(): NetcattyAiBridge | undefined {
  return (window as unknown as { netcatty?: NetcattyAiBridge }).netcatty;
}

export function normalizeCodexBridgeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("No handler registered for 'netcatty:ai:codex:")) {
    return "Codex main-process handlers are not loaded yet. Fully restart Intelligent Terminal, or restart the Electron dev process, then try again.";
  }
  return message;
}
