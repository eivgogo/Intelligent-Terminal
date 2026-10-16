import { clearAllPendingApprovals } from '../shared/approvalGate';
import { globalTraceStore } from './traceStore';
import type { AgentBackend } from './types';

export type StopAgentTurnReason = 'user' | 'slash';

export interface AgentStopBridge {
  aiCancelExec?(chatSessionId: string): Promise<unknown>;
  aiSdkAgentCancel?(requestId: string, chatSessionId?: string): Promise<{ ok: boolean; error?: string }>;
  aiSetChatSessionCancelled?(chatSessionId: string, cancelled?: boolean): Promise<{ ok: boolean; error?: string }>;
}

export interface StopAgentTurnParams {
  chatSessionId: string;
  abortController?: AbortController | null;
  bridge?: AgentStopBridge | null;
  reason?: StopAgentTurnReason;
  backend?: AgentBackend;
}

let stopEventCounter = 0;

function nextStopEventId(): string {
  stopEventCounter += 1;
  return `turn-end-${Date.now()}-${stopEventCounter}`;
}

/**
 * Unified stop entry for external SDK agents and MCP tool surfaces.
 */
export async function stopAgentTurn({
  chatSessionId,
  abortController,
  bridge,
  reason = 'user',
  backend = 'external-sdk',
}: StopAgentTurnParams): Promise<void> {
  abortController?.abort();
  clearAllPendingApprovals(chatSessionId);

  const tasks: Array<Promise<unknown>> = [];
  if (bridge?.aiCancelExec) {
    tasks.push(bridge.aiCancelExec(chatSessionId).catch(() => {}));
  }
  if (bridge?.aiSdkAgentCancel) {
    tasks.push(bridge.aiSdkAgentCancel('', chatSessionId).catch(() => {}));
  }
  if (bridge?.aiSetChatSessionCancelled) {
    tasks.push(bridge.aiSetChatSessionCancelled(chatSessionId, true).catch(() => {}));
  }
  await Promise.all(tasks);

  globalTraceStore.append({
    id: nextStopEventId(),
    type: 'turn_end',
    sessionId: chatSessionId,
    chatSessionId,
    backend,
    timestamp: Date.now(),
    reason: 'aborted',
    ...(reason === 'slash' ? { backendLabel: 'slash-stop' } : {}),
  });
}

/**
 * Clear the main-process cancelled flag when a new agent turn begins.
 */
export async function clearChatSessionCancelled(
  chatSessionId: string,
  bridge?: AgentStopBridge | null,
): Promise<void> {
  await bridge?.aiSetChatSessionCancelled?.(chatSessionId, false).catch(() => {});
}
