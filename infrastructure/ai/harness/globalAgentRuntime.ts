import { AgentRuntime } from './agentRuntime';
import { externalSdkTurnDriver } from './turnDrivers/externalSdkTurnDriver';

export const globalAgentRuntime = new AgentRuntime({
  drivers: [externalSdkTurnDriver],
});

export function getAgentRuntime(): AgentRuntime {
  return globalAgentRuntime;
}
