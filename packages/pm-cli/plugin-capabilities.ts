import { z } from 'zod';
import { AGENT_CHAT_TOOL_REGISTRY, agentChatToolDefinitions } from '../application/src/agent-chat-tools.ts';
import { pmToolCallRecordSchema, pmToolCallProjectionSchema, pmToolInvocationSchema } from '../agent-contracts/src/pm-tools.ts';

export const PLUGIN_OPERATION_POLICY = { access: 'full', enforcement: 'audit-only', interactiveOperationPermission: false } as const;

/** Build metadata only. Runtime discovery and existing PM authority remain authoritative. */
export function pluginCapabilities() {
  return {
    schemaVersion: 1,
    plugin: 'dovspace-pm',
    policy: PLUGIN_OPERATION_POLICY,
    authority: 'Runtime tools/list and current PM authorization; this snapshot grants no access.',
    invocationSchema: z.toJSONSchema(pmToolInvocationSchema, { io: 'input', unrepresentable: 'any' }),
    resultSchema: z.toJSONSchema(pmToolCallRecordSchema, { io: 'output', unrepresentable: 'any' }),
    projectionSchema: z.toJSONSchema(pmToolCallProjectionSchema, { io: 'output', unrepresentable: 'any' }),
    tools: AGENT_CHAT_TOOL_REGISTRY.map(tool => ({
      ...tool,
      risk: tool.write ? 'mutation' : 'read',
      permissionSource: 'existing-pm-capabilities',
      availability: 'runtime-discovery-required',
      inputSchema: agentChatToolDefinitions.find(definition => definition.function.name === tool.name)!.function.parameters,
    })),
    gatewayControls: {
      discovery: 'pm_list_workspaces',
      recovery: { name: 'pm_get_operation_result', method: 'query-original-operation-only', redispatch: false },
      traceAuthority: 'server',
      externalExecutionRoot: 'external',
    },
  };
}
