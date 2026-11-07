import { z } from 'zod';
import { ROADMAP_ORIGIN, roadmapOriginSchema, roadmapStoreSchema, type RoadmapDeliveryRead, type RoadmapDeliveryScope, type RoadmapRead } from '../../../../../packages/contracts/src/product-roadmap.ts';
import type { DeliveryScope, TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import { DeliveryError, type DeliveryTask } from '../../../../../packages/application/src/task-code-delivery.ts';
import { authorizeDelivery, requestDeliveryPm } from './authority.ts';
import { deliveryStore, deliveryTaskRevision } from './binding.ts';
import { git, githubRepository, verifyWorktree } from './git.ts';
import { DeliveryGitHub } from './github.ts';
const github = new DeliveryGitHub();
export type RoadmapDeliveryPorts = {
  request: typeof requestDeliveryPm; list: typeof deliveryStore.list;
  authorize: typeof authorizeDelivery; revision: typeof deliveryTaskRevision;
  git: typeof git; verify: typeof verifyWorktree; feedback: typeof github.feedback;
};
const defaultPorts: RoadmapDeliveryPorts = { request: requestDeliveryPm, list: deliveryStore.list, authorize: authorizeDelivery,
  revision: deliveryTaskRevision, git, verify: verifyWorktree, feedback: value => github.feedback(value) };
export function confirmedDelivery(value: TaskCodeDelivery): boolean {
  return !value.pending && !value.error && !!value.head && !!value.pr && !!value.test?.passed && value.feedback?.head === value.head && value.feedback.state !== 'closed' && value.feedback.checks.length > 0 && value.feedback.checks.every(c => c.conclusion === 'success');
}
async function projectPlan(scope: { workspaceId: string; projectId: string }, headers: Headers, ports: RoadmapDeliveryPorts): Promise<RoadmapRead> {
  const raw = await ports.request(`/api/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/projects/${encodeURIComponent(scope.projectId)}/product-roadmap`, headers);
  const parsed = z.object({ projectId: z.string(), archived: z.boolean(), store: roadmapStoreSchema, tasks: z.record(z.string(), z.array(z.object({ nodeId: z.uuid(), taskId: z.string().regex(/^TASK-\d+$/), title: z.string(), revision: z.string(), archived: z.boolean(), drifted: z.boolean(), status: z.string() }))) }).parse(raw);
  if (parsed.projectId !== scope.projectId || parsed.archived) throw new DeliveryError('roadmap_scope', '项目不可用或已归档。');
  return raw as RoadmapRead;
}
async function taskRoadmap(scope: DeliveryScope, headers: Headers, ports: RoadmapDeliveryPorts) {
  const raw = z.object({ entity: z.record(z.string(), z.unknown()) }).parse(await ports.request(`/api/v1/workspaces/${scope.workspaceId}/core/files/${encodeURIComponent(scope.taskId)}`, headers));
  if (raw.entity[ROADMAP_ORIGIN] === undefined) return null;
  const origin = roadmapOriginSchema.parse(raw.entity[ROADMAP_ORIGIN]), plan = await projectPlan(scope, headers, ports);
  const release = plan.store.releases.find(r => r.id === origin.releaseId), rows = plan.tasks[origin.releaseId] ?? [];
  const node = release?.plan.nodes.find(n => n.id === origin.nodeId), own = rows.filter(r => r.taskId === scope.taskId && r.nodeId === origin.nodeId);
  if (!node || own.length !== 1 || own[0]!.archived || own[0]!.drifted) throw new DeliveryError('roadmap_changed', '任务与已发布 Roadmap 不一致，请先核对需求，不会启动开发。');
  return { node, rows };
}
export async function roadmapSuggestedBase(scope: DeliveryScope, headers: Headers, ports: RoadmapDeliveryPorts = defaultPorts): Promise<string | null> {
  const context = await taskRoadmap(scope, headers, ports);
  if (!context || context.node.dependsOn.length !== 1) return null;
  const task = context.rows.find(r => r.nodeId === context.node.dependsOn[0] && !r.archived && !r.drifted);
  const value = task && ports.list().find(v => v.workspaceId === scope.workspaceId && v.projectId === scope.projectId && v.taskId === task.taskId);
  return value && confirmedDelivery(value) ? value.git?.branch ?? null : null;
}
/** Verify every prerequisite in the exact fetched base. Never merge or checkout source code. */
export async function checkRoadmapBase(task: DeliveryTask, baseBranch: string, headers: Headers, pinnedBase?: string, ports: RoadmapDeliveryPorts = defaultPorts): Promise<void> {
  const context = await taskRoadmap(task, headers, ports);
  if (!context || !context.node.dependsOn.length) return;
  const prerequisites: TaskCodeDelivery[] = [];
  for (const id of context.node.dependsOn) {
    const rows = context.rows.filter(r => r.nodeId === id);
    if (rows.length !== 1 || rows[0]!.archived || rows[0]!.drifted) throw new DeliveryError('roadmap_prerequisite', '前置任务未创建、已变更或已归档。');
    const value = ports.list().find(v => v.workspaceId === task.workspaceId && v.projectId === task.projectId && v.taskId === rows[0]!.taskId);
    if (!value || !confirmedDelivery(value) || value.git?.root !== task.root) throw new DeliveryError('roadmap_prerequisite', '前置任务尚无同版本测试 / PR / CI 证据，或不在同一仓库。');
    const current = await ports.authorize(value, false, headers);
    if (current.revision !== ports.revision(value)) throw new DeliveryError('roadmap_prerequisite', '前置任务需求版本已变化。');
    const feedback = await ports.feedback(value);
    if (!confirmedDelivery({ ...value, feedback })) throw new DeliveryError('roadmap_prerequisite', '前置任务最新 GitHub 结果未通过或版本已变化。');
    prerequisites.push(value);
  }
  const remote = (await ports.git(task.root, 'remote', 'get-url', 'origin')).trim(); githubRepository(remote);
  if (prerequisites.some(v => v.git!.remote !== remote)) throw new DeliveryError('roadmap_repository', '前置任务仓库不一致。');
  await ports.git(task.root, 'check-ref-format', '--branch', baseBranch);
  if (!pinnedBase) await ports.git(task.root, 'fetch', '--no-tags', 'origin', `refs/heads/${baseBranch}`);
  const base = pinnedBase ?? (await ports.git(task.root, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}')).trim();
  for (const value of prerequisites) {
    try { await ports.git(task.root, 'merge-base', '--is-ancestor', value.head!, base); }
    catch { throw new DeliveryError('roadmap_base_missing', '所选基线不包含前置成果。线性任务可选择前置任务已推送的分支；多前置需先人工集成。不会自动合并。'); }
  }
}
export async function inspectRoadmapDelivery(scope: RoadmapDeliveryScope, headers: Headers, refresh: boolean, ports: RoadmapDeliveryPorts = defaultPorts): Promise<RoadmapDeliveryRead> {
  const plan = await projectPlan(scope, headers, ports), release = plan.store.releases.find(r => r.id === scope.releaseId);
  if (!release) throw new DeliveryError('roadmap_missing', '发布版本不存在。');
  const records: TaskCodeDelivery[] = [], items: RoadmapDeliveryRead['items'] = [];
  for (const node of release.plan.nodes) {
    const rows = (plan.tasks[release.id] ?? []).filter(t => t.nodeId === node.id), row = rows.length === 1 ? rows[0] : undefined;
    const stored = row && ports.list().find(d => d.workspaceId === scope.workspaceId && d.projectId === scope.projectId && d.taskId === row.taskId);
    const value = stored ? structuredClone(stored) : undefined;
    let issue = !row ? '尚未创建任务或关联不唯一' : row.archived || row.drifted ? '任务已归档或需求偏离计划' : !value ? '尚未开发交付' : null;
    if (value) {
      const current = await ports.authorize(value, false, headers);
      if (current.revision !== ports.revision(value) || current.root !== value.git?.root) issue = '需求版本或项目目录已变化';
      if (refresh && value.pr) value.feedback = await ports.feedback(value);
      if (!confirmedDelivery(value)) issue ??= '同版本测试、PR 或 CI 证据不完整';
      records.push(value);
    }
    items.push({ taskId: row?.taskId ?? '', title: node.title, deliveryId: value?.id ?? null, head: value?.head ?? null, pr: value?.pr?.url ?? null, tested: !!value?.test?.passed, ci: value ? confirmedDelivery(value) : false, included: false, observedAt: value?.feedback?.observedAt ?? null, issue });
  }
  const candidate = records.filter(record => !items.find(item => item.deliveryId === record.id)?.issue).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (candidate?.head && candidate.git && confirmedDelivery(candidate)) {
    await ports.verify(candidate);
    for (const item of items) {
      const value = records.find(r => r.id === item.deliveryId);
      if (!value?.head || value.git?.commonDirectory !== candidate.git.commonDirectory || value.git?.remote !== candidate.git.remote) { item.issue ??= '提交不在同一仓库'; continue; }
      try { await ports.git(candidate.git.directory, 'merge-base', '--is-ancestor', value.head, candidate.head); item.included = true; }
      catch { item.issue ??= '集成候选没有包含该任务提交'; }
    }
  }
  const eligible = !!candidate?.head && items.length === release.plan.nodes.length && items.length > 0 && items.every(i => !i.issue && i.included);
  return { eligible, reason: eligible ? '已核对所有任务提交都在同一个候选版本中，且各自测试 / CI 通过。仍需跨任务功能验收。' : '尚未形成可核验的集成版本；不以任务数量或状态冒充 App 完成。', checkedAt: new Date().toISOString(), candidate: eligible ? { id: candidate!.id, head: candidate!.head! } : null, items };
}
