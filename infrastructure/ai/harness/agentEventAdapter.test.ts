import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStepHandleNoticeMessage,
  mapSdkStreamEventToAgentEvents,
} from './agentEventAdapter';

describe('agentEventAdapter', () => {
  it('detects step handle notice messages for prepareStep dedup', () => {
    assert.equal(
      isStepHandleNoticeMessage('[step 2] Tool output handles available: tool-output-abc'),
      true,
    );
    assert.equal(isStepHandleNoticeMessage('regular user message'), false);
  });

  it('maps SDK activity events into the unified trace protocol', () => {
    const context = { sessionId: 'chat-1', turnId: 'turn-1' };
    const fileChange = mapSdkStreamEventToAgentEvents({
      type: 'file-change',
      itemId: 'patch-1',
      status: 'completed',
      changes: [{ path: 'src/app.ts', kind: 'update' }],
    }, context);
    const webSearch = mapSdkStreamEventToAgentEvents({
      type: 'web-search', itemId: 'search-1', query: 'Codex events', status: 'running',
    }, context);
    const plan = mapSdkStreamEventToAgentEvents({
      type: 'plan-update', itemId: 'plan-1', status: 'completed',
      items: [{ text: 'Map events', completed: true }],
    }, context);
    const warning = mapSdkStreamEventToAgentEvents({
      type: 'warning', itemId: 'warning-1', message: 'recoverable',
    }, context);

    assert.equal(fileChange[0]?.type, 'file_change');
    assert.equal(webSearch[0]?.type, 'web_search');
    assert.equal(plan[0]?.type, 'plan_update');
    assert.equal(warning[0]?.type, 'error');
    assert.equal((warning[0] as { recoverable?: boolean }).recoverable, true);
  });

  it('maps actual SDK usage including cached and reasoning tokens', () => {
    const events = mapSdkStreamEventToAgentEvents({
      type: 'usage',
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 25,
      reasoningTokens: 10,
      totalTokens: 125,
    }, { sessionId: 'chat-1', turnId: 'turn-1' });
    assert.deepEqual(events[0] && {
      type: events[0].type,
      promptTokens: 'promptTokens' in events[0] ? events[0].promptTokens : undefined,
      cachedPromptTokens: 'cachedPromptTokens' in events[0] ? events[0].cachedPromptTokens : undefined,
      completionTokens: 'completionTokens' in events[0] ? events[0].completionTokens : undefined,
      reasoningTokens: 'reasoningTokens' in events[0] ? events[0].reasoningTokens : undefined,
      totalTokens: 'totalTokens' in events[0] ? events[0].totalTokens : undefined,
      estimated: 'estimated' in events[0] ? events[0].estimated : undefined,
    }, {
      type: 'usage',
      promptTokens: 100,
      cachedPromptTokens: 40,
      completionTokens: 25,
      reasoningTokens: 10,
      totalTokens: 125,
      estimated: false,
    });
  });
});
