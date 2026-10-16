/**
 * Neutral renderer bridge + executor-context types shared by the in-app agent
 * surface and the external SDK agent path.
 */
import type { TerminalContextReader } from '../../domain/terminalContextRead';

/**
 * Bridge interface for the renderer agent to interact with the Electron main
 * process. Mirrors the AI-related subset of `window.netcatty` from
 * electron/preload.cjs.
 */
export interface NetcattyBridge {
  aiExec(
    sessionId: string,
    command: string,
    chatSessionId?: string,
  ): Promise<{
    ok: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: string;
  }>;
  /**
   * Cancel any in-flight agent command execution scoped to the given chat
   * session. Idempotent — safe to call when nothing is running.
   */
  aiCancelExec?(chatSessionId: string): Promise<unknown>;
  aiSetChatSessionCancelled?(chatSessionId: string, cancelled?: boolean): Promise<{ ok: boolean; error?: string }>;
}

/** Workspace context provided to the executor. */
export interface ExecutorContext {
  // Available sessions in scope
  sessions: Array<{
    sessionId: string;
    hostId: string;
    hostname: string;
    label: string;
    os?: string;
    username?: string;
    protocol?: string;
    shellType?: string;
    deviceType?: string;
    connected: boolean;
  }>;
  // Workspace info
  workspaceId?: string;
  workspaceName?: string;
  readTerminalContext?: TerminalContextReader;
}
