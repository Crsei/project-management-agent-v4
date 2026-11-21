import { studioNativeTemplateRequiresProvider, type StudioExecutionRequest } from '../../../../../packages/contracts/src/automation-studio.ts';
import { assertDefinitionLaunchable } from '../collaboration/definitions.ts';

/**
 * A pinned Agent is execution identity, not extra authority: the frozen version must
 * still be launchable for this workspace/project, remain read-only, and match the
 * Provider/model frozen in the automation. Its instructions are bounded prompt text.
 */
export function automationExecutionAgentInstructions(request: StudioExecutionRequest): string | null {
  const pin = request.config.executionAgent;
  if (!pin) return null;
  const action = request.config.action;
  if (action.kind === 'template' && !studioNativeTemplateRequiresProvider(action.templateId))
    throw Object.assign(new Error('Deterministic PM templates do not use an Agent identity; remove the Agent selection.'), { status: 412, code: 'automation_agent_not_applicable' });
  const launchable = assertDefinitionLaunchable({ kind: 'agent', agentId: pin.id, agentVersion: pin.version }, request.workspaceId, request.projectId);
  const config = launchable.agentVersions[0]!.config;
  if (config.executionMode !== 'read-only')
    throw Object.assign(new Error('Automations execute read-only; select an Agent whose frozen version is read-only.'), { status: 412, code: 'automation_agent_not_read_only' });
  if (action.kind === 'script' || config.providerInstanceId !== action.providerInstanceId || config.model !== action.model)
    throw Object.assign(new Error('The pinned Agent version no longer matches this automation’s Provider and model. Reselect the Agent and save again.'), { status: 409, code: 'automation_agent_identity_changed' });
  return config.instructions.trim() || null;
}
