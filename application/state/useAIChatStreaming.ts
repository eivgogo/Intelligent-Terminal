/**
 * useAIChatStreaming — React UI layer for AI chat streaming.
 *
 * Turn orchestration lives in AgentRuntime + TurnDrivers; this hook only
 * manages streaming state, abort controllers, and UI callbacks.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AIPermissionMode,
  AIToolIntegrationMode,
  ChatMessage,
  ExternalAgentConfig,
  ProviderConfig,
} from '../../infrastructure/ai/types';
import { getAgentRuntime } from '../../infrastructure/ai/harness/globalAgentRuntime';
import type {
  TurnSteerInput,
  TurnSteerResult,
} from '../../infrastructure/ai/harness/turnDrivers/types';
import { classifyError } from '../../infrastructure/ai/errorClassifier';
import { latestAISessionsSnapshot } from './aiStateSnapshots';
import {
  generateId,
  getNetcattyBridge,
  type DefaultTargetSessionHint,
  type TerminalSessionInfo,
} from '../../infrastructure/ai/aiChatStreamingSupport';
import { useAgentCompactionUi } from './useAgentCompactionUi';

export { getNetcattyBridge } from '../../infrastructure/ai/aiChatStreamingSupport';
export type { ActiveCompactionUi } from './useAgentCompactionUi';
export type { DefaultTargetSessionHint } from '../../infrastructure/ai/aiChatStreamingSupport';

const sharedStreamingSessionIds = new Set<string>();
const sharedAbortControllers = new Map<string, AbortController>();
const streamingSubscribers = new Set<() => void>();

/** Whether a chat session still has an active stream (used to keep panel mounted while hidden). */
export function isAIChatSessionStreaming(sessionId: string | null | undefined): boolean {
  return !!sessionId && sharedStreamingSessionIds.has(sessionId);
}

function emitStreamingStoreChange(): void {
  streamingSubscribers.forEach(listener => {
    try {
      listener();
    } catch (err) {
      console.error('[AIChatStreaming] Failed to notify streaming subscriber:', err);
    }
  });
}

export interface UseAIChatStreamingParams {
  maxIterations: number;
  addMessageToSession: (sessionId: string, message: ChatMessage) => void;
  updateLastMessage: (sessionId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  updateMessageById: (sessionId: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  persistContextCompaction?: (
    sessionId: string,
    compaction: import('../../infrastructure/ai/types').AISessionContextCompaction,
  ) => void;
}

export interface UseAIChatStreamingReturn {
  streamingSessionIds: Set<string>;
  setStreamingForScope: (key: string, val: boolean) => void;
  abortControllersRef: React.MutableRefObject<Map<string, AbortController>>;
  sendToExternalAgent: (
    sessionId: string,
    assistantMsgId: string,
    trimmed: string,
    agentConfig: ExternalAgentConfig,
    abortController: AbortController,
    attachedImages: Array<{ base64Data: string; mediaType: string; filename?: string; filePath?: string }>,
    context: SendToExternalContext,
  ) => Promise<void>;
  steerExternalAgent: (input: TurnSteerInput) => Promise<TurnSteerResult>;
  reportStreamError: (sessionId: string, abortSignal: AbortSignal, err: unknown) => void;
  activeCompaction: import('./useAgentCompactionUi').ActiveCompactionUi | null;
}

export interface SendToExternalContext {
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

export function useAIChatStreaming({
  addMessageToSession,
  updateLastMessage,
  updateMessageById,
  persistContextCompaction,
}: UseAIChatStreamingParams): UseAIChatStreamingReturn {
  const [streamingSessionIds, setStreamingSessions] = useState<Set<string>>(
    () => new Set(sharedStreamingSessionIds),
  );

  useEffect(() => {
    const syncFromStore = () => {
      setStreamingSessions(new Set(sharedStreamingSessionIds));
    };
    streamingSubscribers.add(syncFromStore);
    syncFromStore();
    return () => {
      streamingSubscribers.delete(syncFromStore);
    };
  }, []);

  const setStreamingForScope = useCallback((key: string, val: boolean) => {
    const hadKey = sharedStreamingSessionIds.has(key);
    if (val) {
      sharedStreamingSessionIds.add(key);
    } else {
      sharedStreamingSessionIds.delete(key);
    }
    if (hadKey !== val) {
      emitStreamingStoreChange();
    }
  }, []);

  const abortControllersRef = useRef<Map<string, AbortController>>(sharedAbortControllers);

  const activeCompaction = useAgentCompactionUi();

  const reportStreamError = useCallback((
    sessionId: string,
    abortSignal: AbortSignal,
    err: unknown,
  ) => {
    if (abortSignal.aborted) return;
    console.error('[AIChatSidePanel] Stream error (full):', err);
    const errorInfo = classifyError(err);
    updateLastMessage(sessionId, msg => ({
      ...msg,
      statusText: '',
      executionStatus: msg.executionStatus === 'running' ? 'failed' : msg.executionStatus,
    }));
    addMessageToSession(sessionId, {
      id: generateId(),
      role: 'assistant',
      content: '',
      errorInfo,
      timestamp: Date.now(),
    });
  }, [updateLastMessage, addMessageToSession]);

  const uiCallbacks = useCallback(() => ({
    addMessageToSession,
    updateLastMessage,
    updateMessageById,
    reportStreamError,
    setStreamingForScope,
    getLatestSession: (sessionId: string) => latestAISessionsSnapshot?.find(s => s.id === sessionId),
    persistContextCompaction,
  }), [addMessageToSession, updateLastMessage, updateMessageById, reportStreamError, setStreamingForScope, persistContextCompaction]);

  const sendToExternalAgent = useCallback(async (
    sessionId: string,
    assistantMsgId: string,
    trimmed: string,
    agentConfig: ExternalAgentConfig,
    abortController: AbortController,
    attachedImages: Array<{ base64Data: string; mediaType: string; filename?: string; filePath?: string }>,
    context: SendToExternalContext,
  ) => {
    const bridge = getNetcattyBridge();
    await getAgentRuntime().runTurn({
      backend: 'external-sdk',
      chatSessionId: sessionId,
      assistantMsgId,
      userText: trimmed,
      signal: abortController.signal,
      agentConfig,
      attachedImages,
      context,
      bridge,
      ui: uiCallbacks(),
    });
  }, [uiCallbacks]);

  const steerExternalAgent = useCallback(async (input: TurnSteerInput) => {
    return getAgentRuntime().steerTurn(input);
  }, []);

  return {
    streamingSessionIds,
    setStreamingForScope,
    abortControllersRef,
    sendToExternalAgent,
    steerExternalAgent,
    reportStreamError,
    activeCompaction,
  };
}
