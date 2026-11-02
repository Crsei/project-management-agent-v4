import { roadmapSuggestedBase } from '../task-delivery/roadmap.ts';
import { TaskWorkflowService } from '../../../../../packages/application/src/task-workflow.ts';
import { DeliveryError } from '../../../../../packages/application/src/task-code-delivery.ts';
import { deliveryService } from '../task-delivery/index.ts';
import { deliveryStore } from '../task-delivery/binding.ts';
import { authorizeDelivery, requestDeliveryPm } from '../task-delivery/authority.ts';
import { z } from 'zod';
import { git, githubRepository } from '../task-delivery/git.ts';
import { resolveProviderRuntime } from '../providers/runtime.ts';
import { workflowStore } from './store.ts';
const active = new Set<string>();
export function workflowService(headers: Headers) {
  return new TaskWorkflowService({
    ...workflowStore,
    transition: async (input, reconcile) => {
      try {
        const result = await requestDeliveryPm(`/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}/workflow-task-transitions${reconcile ? '/reconcile' : ''}`, headers, input);
        return z.discriminatedUnion('status', [z.object({ status: z.literal('applied'), revision: z.string().min(1), commandId: z.string().min(1) }), z.object({ status: z.enum(['not_found', 'pending']) })]).parse(result);
      } catch { throw new DeliveryError('workflow_transition_unconfirmed', 'PM 状态转换未确认。请核对登录/权限、当前任务状态、版本和配置状态边；恢复只核对原收据。'); }
    },
    authorize: (scope, write) => authorizeDelivery(scope, write, headers),
    defaultBase: async (root, scope) => {
      if (scope) { const suggested = await roadmapSuggestedBase(scope, headers); if (suggested) return suggested; }
      try { return (await git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).trim().replace(/^origin\//, ''); } catch { /* Only suggest a branch observed in this repository. */ }
      const refs = (await git(root, 'for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin')).trim().split('\n').filter(v => v && v !== 'HEAD');
      return refs.includes('main') ? 'main' : refs.includes('master') ? 'master' : refs.length === 1 ? refs[0]! : null;
    },
    repository: async root => {
      const remote = (await git(root, 'remote', 'get-url', 'origin')).trim();
      if ((await git(root, 'remote', 'get-url', '--push', 'origin')).trim() !== remote) throw new DeliveryError('repository_changed', 'origin 读写地址不一致。');
      const { owner, repo } = githubRepository(remote); return `${owner}/${repo}`;
    },
    provider: async input => {
      const provider = await resolveProviderRuntime({ providerInstanceId: input.providerInstanceId, modelName: input.model });
      if (input.consent.worktreeWrite && provider.driver !== 'codex') throw new DeliveryError('provider_not_supported', '第一版工作流写入仅支持已确认的 Codex worktree 策略。');
    },
    delivery: deliveryService(headers), readDelivery: deliveryStore.read,
  }, active);
}
