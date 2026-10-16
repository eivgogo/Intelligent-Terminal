import assert from 'node:assert/strict';
import test from 'node:test';
import React, { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useAgentDiscovery } from './useAgentDiscovery';

interface ProbeApi {
  discoveredAgents: unknown[];
  isDiscovering: boolean;
  rediscover: () => Promise<unknown>;
}

test('agent discovery clears "discovering" after a StrictMode remount', async () => {
  // StrictMode (and Fast Refresh) run a mount effect's cleanup while keeping
  // refs. The mount effect must re-arm its mounted flag, otherwise every
  // discovery result is dropped and `isDiscovering` stays true, leaving the UI
  // stuck on "Detecting...".
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

  const globalRef = globalThis as unknown as { window?: unknown };
  const previousWindow = globalRef.window;
  let discoverCalls = 0;
  globalRef.window = {
    netcatty: {
      aiDiscoverAgents: async () => {
        discoverCalls += 1;
        return [{
          id: 'discovered_opencode',
          command: 'opencode',
          name: 'OpenCode',
          path: '/usr/bin/opencode',
          args: [],
        }];
      },
    },
  };

  let api: ProbeApi | null = null;
  const Probe = () => {
    // Capture the scheduled run so only the explicit call drives the test.
    const discovery = useAgentDiscovery([], undefined, {
      schedule: () => () => {},
    });
    api = discovery as unknown as ProbeApi;
    return null;
  };

  let renderer: ReactTestRenderer | null = null;
  try {
    await act(async () => {
      renderer = create(React.createElement(StrictMode, null, React.createElement(Probe)));
    });

    await act(async () => {
      await api!.rediscover();
    });

    assert.equal(discoverCalls, 1, 'discovery should run once');
    assert.equal(
      api!.isDiscovering,
      false,
      'isDiscovering must clear after a StrictMode remount',
    );
    assert.equal(
      api!.discoveredAgents.length,
      1,
      'discovery results must be applied after a StrictMode remount',
    );
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    globalRef.window = previousWindow;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
