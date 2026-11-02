import * as Effect from 'effect/Effect';
import type { ProviderRuntimeHostService } from '@t3tools/provider-core/server/ProviderRuntimeHost';
import { ClaudeAgentSdkQueryRunner, type ClaudeAgentSdkQueryOpenInput, type ClaudeAgentSdkQueryRunnerShape } from '../../../../../../vendor/t3code/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts';

/** The original SDK/adapter still owns execution. Only a server-issued analysis binding removes tools. */
export function restrictPmAnalysisQueries(original: ClaudeAgentSdkQueryRunnerShape, runtimeHost: ProviderRuntimeHostService, instanceId: Parameters<ProviderRuntimeHostService['read']>[0]['providerInstanceId']): ClaudeAgentSdkQueryRunnerShape {
  return ClaudeAgentSdkQueryRunner.of({
    ...original,
    open: (input: ClaudeAgentSdkQueryOpenInput) => Effect.gen(function* () {
      const binding = yield* runtimeHost.read({ threadId: input.threadId, providerInstanceId: instanceId });
      if (binding?.promptAuthorization !== 'technical-no-tools') return yield* original.open(input);
      if (binding.mcpServers.length || binding.cwd !== input.options.cwd) throw new Error('Read-only analysis cannot inherit tools or another working directory.');
      // SDK tool removal is authoritative. A callback denial is defense in depth,
      // not a prompt promise; no connector descriptors or native hooks survive.
      const { hooks: _hooks, extraArgs: _extraArgs, ...options } = input.options;
      return yield* original.open({ ...input, options: {
        ...options, tools: [], allowedTools: [], disallowedTools: ['*'], mcpServers: {},
        settingSources: [], plugins: [], strictMcpConfig: true,
        settings: { disableAllHooks: true },
        canUseTool: async () => ({ behavior: 'deny' as const, message: 'PM automation analysis has no tool authority.' }),
      } });
    }),
  });
}

export function pmAnalysisProviderSupport(driver: string): { available: boolean; reason: string | null } {
  return driver === 'claude' ? { available: true, reason: null } : { available: false, reason: `Provider ${driver} has no verified native no-tools analysis transport. Select an enabled Claude Provider; a read-only sandbox alone does not disable code execution.` };
}
