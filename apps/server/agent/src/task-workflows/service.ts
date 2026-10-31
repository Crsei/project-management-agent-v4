import { TaskWorkflowService } from '../../../../../packages/application/src/task-workflow.ts';
import { DeliveryError } from '../../../../../packages/application/src/task-code-delivery.ts';
import { deliveryService } from '../task-delivery/index.ts';
import { deliveryStore } from '../task-delivery/binding.ts';
import { authorizeDelivery } from '../task-delivery/authority.ts';
import { git, githubRepository } from '../task-delivery/git.ts';
import { resolveProviderRuntime } from '../providers/runtime.ts';
import { workflowStore } from './store.ts';
const active = new Set<string>();
export function workflowService(headers: Headers) {
  return new TaskWorkflowService({
    ...workflowStore,
    authorize: (scope, write) => authorizeDelivery(scope, write, headers),
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
