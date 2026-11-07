import { z } from 'zod';
import type { Pool } from 'pg';
import type { AgentChatToolResult } from '../../../../packages/agent-contracts/src/pm-tool-result.ts';
import { assertAgentToolRecord, assertAgentToolOrdinaryMutation, type AgentChatToolContext } from '../../../../packages/application/src/agent-chat-tools.ts';
import type { PmAutomationMutationPort } from '../../../../packages/application/src/automation-pm.ts';
import { requestHash } from '../../../../packages/application/src/kernel.ts';
import { DomainError } from '../../../../packages/domain/src/core.ts';
import type { AgentChatTools } from './agent-chat-tools.ts';
import { CoreWorkspacePool, authorizeCoreScope, executeAuditedCoreMutation, nativeCommandId, recoverAuditedCoreMutation } from './core-routes.ts';
import { patchMarkdown } from '../../../../packages/pm-markdown/index.ts';
import { coreRecordToEntity, updateWorkItemRaw } from './core-adapter.ts';
import { assertTaskCreationProject } from '../../../../packages/application/src/core-task-creation.ts';

const contentSchema = z.strictObject({ id: z.string().regex(/^TASK-\d+$/), revision: z.string().regex(/^[a-f0-9]{64}$/), title: z.string().trim().min(1).max(300), description: z.string().max(24000).nullable(), acceptanceCriteria: z.array(z.string().max(4000)).max(100).nullable(), progressNote: z.string().max(8000).nullable() });
/** Content/acceptance edits use the same canonical Markdown layout and audited mutation service as native PM commands. */
export function createPmAutomationMutationPort(options: { database: () => Pool; coreWorkspaces: CoreWorkspacePool; tools: AgentChatTools }): PmAutomationMutationPort {
  async function content(input: unknown, context: AgentChatToolContext, recover: boolean): Promise<AgentChatToolResult | null> {
    const args = contentSchema.parse(input), action = 'UpdateCoreSource';
    const commandId = nativeCommandId(context.workspaceId, context.actor.id, action, args.id, context.operationId);
    const inputHash = requestHash({ action, targetId: args.id, input: args });
    let revision: string;
    if (recover) {
      const saved = await recoverAuditedCoreMutation({ database: options.database, pool: options.coreWorkspaces, principal: context.actor, workspaceId: context.workspaceId, commandId, hash: inputHash,
        checkProject: projectId => { if (!context.scope.projectIds.includes(projectId)) throw new DomainError('not_found_or_forbidden', 'Original task update is outside this project', 404); } });
      if (!saved || saved.kind === 'http_pending') return null;
      if (saved.kind === 'http_rejected') throw new DomainError('agent_tool_recovered_rejection', 'The original task content write was rejected', 409);
      if (!saved.revision) return null;
      revision = saved.revision;
    } else {
      const scope = await authorizeCoreScope(options.database(), context.actor, context.workspaceId, 'planning.edit'), workspace = await options.coreWorkspaces.get(context.workspaceId);
      const before = workspace.get(args.id); scope.entity(before); assertAgentToolRecord(context.scope, before);
      if (before.entity.entity !== 'work_item' || before.revision !== args.revision) throw new DomainError('version_conflict', 'Current task differs from the explicitly reviewed revision', 409);
      const original = coreRecordToEntity(context.workspaceId, before);
      const description = args.description ?? String(original.data.description ?? '');
      const content = updateWorkItemRaw(before, args.title, description, (args.acceptanceCriteria ?? before.entity.checklist.map(item => item.text)).map(text => ({ text })));
      const raw = args.progressNote === null ? content : patchMarkdown(content, { 'x-pm-progress-note': args.progressNote }, workspace.configuration().config);
      const result = await executeAuditedCoreMutation({ database: options.database, principal: context.actor, workspace, scope, action, input: args, targetId: args.id, before, key: context.operationId, trustedSource: { kind: 'automation', requesterId: context.actor.id },
        mutate: (_key, guard) => workspace.save(args.id, raw, args.revision, guard),
        guard: (previous, after) => { if (previous) assertAgentToolRecord(context.scope, previous); assertAgentToolOrdinaryMutation(previous, after); if (after.project !== before.entity.project) throw new DomainError('automation_pm_scope_forbidden', 'A content proposal cannot move projects', 403); assertTaskCreationProject(workspace.get(String(after.project)), workspace.configuration().config); },
        ...(context.checkAuthorization ? { checkAuthorization: context.checkAuthorization } : {}) });
      if (!('entity' in result)) throw new DomainError('core_write_outcome_unknown', 'Native content write returned no source receipt', 503);
      revision = result.revision;
    }
    return { kind: 'task', items: [], nextCursor: null, truncated: false, sources: [], receipt: { kind: 'core', operationId: context.operationId, commandId, action, targetId: args.id, revision } };
  }
  return {
    async execute(name, input, context) { if (name !== 'pm_update_task_content') return options.tools.execute(name, input, context); const result = await content(input, context, false); if (!result) throw new DomainError('core_write_outcome_unknown', 'Original content outcome is unknown', 503); return result; },
    recover: (name, input, context) => name === 'pm_update_task_content' ? content(input, context, true) : options.tools.recover(name, input, context),
  };
}
