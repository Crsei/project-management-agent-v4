import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ProviderRuntimeHostBinding } from '@t3tools/provider-core/server/ProviderRuntimeHost';
import { getChatGeneration, type ChatGeneration } from '../durable/chat-runtime.ts';
import { dataDirectory } from '../paths.ts';
import { verifyAutomationServiceBearer } from '../../../../../packages/infrastructure/src/automation-execution-client.ts';
import { resolveAutomationIntegrationDescriptors, recoverAutomationIntegrationGrants, recoverAutomationIntegrationGrantFile } from '../../../../../packages/infrastructure/src/automation-integrations-runtime.ts';
import { automationRequestForNativeGeneration } from './context.ts';
import { openNativeTemplateScratchTools, recoverNativeTemplateScratchTools } from './native-templates/workspace-tools.ts';
import { assertAutomationProviderToolSupport } from './provider-tools.ts';

export type AutomationGenerationConnectors = { mcpServers: ProviderRuntimeHostBinding['mcpServers']; close: () => Promise<void> };
const grantRoot = () => path.join(dataDirectory(), 'automation-grants');
/** Imported only by the trusted Chat launch path; no descriptor fields are accepted in Chat JSON. */
export async function openAutomationGenerationConnectors(generation: ChatGeneration, headers: Headers | undefined, authorizeExecution: (action: 'tool') => Promise<void>): Promise<AutomationGenerationConnectors> {
  const request = automationRequestForNativeGeneration(generation);
  if (!request || (request.config.action.kind !== 'template' && !request.config.action.plugins.length)) return { mcpServers: [], close: async () => {} };
  const authorization = headers?.get('authorization');
  const identity = authorization?.startsWith('Bearer ') ? verifyAutomationServiceBearer(authorization.slice(7)) : null;
  if (!identity || identity.executionId !== request.executionId || identity.actorId !== request.actorId || identity.workspaceId !== request.workspaceId || identity.projectId !== request.projectId || identity.requestId !== request.requestId || identity.definitionId !== request.definitionId || identity.definitionRevision !== request.definitionRevision) throw new Error('Connector injection requires the original, currently authorized PM service execution.');
  await authorizeExecution('tool');
  assertAutomationProviderToolSupport(request.config);
  if (request.config.action.kind === 'template') return openNativeTemplateScratchTools(generation, headers, authorizeExecution);
  await mkdir(grantRoot(), { recursive: true, mode: 0o700 });
  const directory = path.join(grantRoot(), generation.id);
  await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o700);
  let connectors: AutomationGenerationConnectors;
  try { connectors = await resolveAutomationIntegrationDescriptors({ request, headers: headers!, generationId: generation.id, grantDirectory: directory }); }
  catch (error) {
    await recoverAutomationIntegrationGrantFile(path.join(directory, `integrations-${generation.id}.json`)).catch(() => undefined);
    throw error;
  }
  let closed = false;
  return { mcpServers: connectors.mcpServers, close: async () => {
    if (closed) return;
    try {
      // Revocation is authoritative on PM; deleting a token file alone never revokes it.
      await connectors.close(); await rm(directory, { recursive: true, force: true }); closed = true;
    } catch (error) {
      throw Object.assign(new Error('Connector grant revocation could not be confirmed; retained the private grant for reconciliation.', { cause: error }), { terminalStatus: 'interrupted' });
    }
  } };
}
export async function recoverAutomationGenerationConnectors(): Promise<void> {
  const results = await Promise.allSettled([
    recoverAutomationIntegrationGrants(grantRoot(), generationId => {
      const generation = getChatGeneration(generationId);
      return generation?.status === 'queued' || generation?.status === 'running';
    }),
    recoverNativeTemplateScratchTools(),
  ]);
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, 'Scoped automation tool recovery could not be confirmed; private reconciliation records were retained.');
}
