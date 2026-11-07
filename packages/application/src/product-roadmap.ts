import { isDeepStrictEqual } from 'node:util';
import { DomainError } from '../../domain/src/core.ts';
import type { Entity, FileRecord } from '../../pm-schema/index.ts';
import { ROADMAP_FIELD, ROADMAP_ORIGIN, emptyRoadmap, productBriefMarkdown, roadmapProblems, roadmapOriginSchema, roadmapStoreSchema, type RoadmapPlan, type RoadmapRead, type RoadmapRelease, type RoadmapStore, type RoadmapTask } from '../../contracts/src/product-roadmap.ts';

const fail = (message: string): never => { throw new DomainError('roadmap_conflict', message, 409); };
export function readRoadmap(project: FileRecord): RoadmapStore {
  if (project.entity.entity !== 'project') fail('产品规划必须属于项目。');
  const raw = project.entity[ROADMAP_FIELD];
  if (raw === undefined) return { schema: 'pm/product-roadmap/v1', draft: emptyRoadmap(), releases: [] };
  const parsed = roadmapStoreSchema.safeParse(raw);
  if (!parsed.success) fail('产品规划数据无法解析；请恢复原始数据，不会用空计划覆盖。');
  return parsed.data!;
}
/** Immutable published requirements and origin identity, including ordinary core edits. */
export function assertRoadmapMetadata(after: Entity, before?: Entity): void {
  if (after[ROADMAP_FIELD] !== undefined) {
    if (after.entity !== 'project') fail('产品规划只能保存在项目上。');
    const next = roadmapStoreSchema.parse(after[ROADMAP_FIELD]);
    const ids = next.releases.map(r => r.id);
    if (new Set(ids).size !== ids.length) fail('发布版本编号重复。');
    for (const release of next.releases) if (roadmapProblems(release.plan).length) fail('发布版本包含无效规划。');
    if (before?.[ROADMAP_FIELD] !== undefined) {
      const old = roadmapStoreSchema.parse(before[ROADMAP_FIELD]);
      if (!isDeepStrictEqual(old.releases, next.releases.slice(0, old.releases.length))) fail('已发布版本不可覆盖或删除；请修改草稿并发布新版本。');
    }
  } else if (before?.[ROADMAP_FIELD] !== undefined) fail('已有产品规划不可直接删除。');
  if (after[ROADMAP_ORIGIN] !== undefined) {
    if (after.entity !== 'work_item') fail('Roadmap 来源只能绑定任务。');
    roadmapOriginSchema.parse(after[ROADMAP_ORIGIN]);
  }
  if (before?.[ROADMAP_ORIGIN] !== undefined && !isDeepStrictEqual(after[ROADMAP_ORIGIN], before[ROADMAP_ORIGIN])) fail('已发布任务的规划来源不可改写。');
}
export function publishRoadmap(store: RoadmapStore, releaseId: string, actor: string, now: string): RoadmapStore {
  const problems = roadmapProblems(store.draft);
  if (problems.length) fail(problems.join('\n'));
  if (store.releases.length >= 20 || store.releases.some(r => r.id === releaseId)) fail('发布版本已存在或已达到20个版本上限。');
  return { ...store, releases: [...store.releases, { id: releaseId, plan: structuredClone(store.draft), publishedAt: now, publishedBy: actor }] };
}
export function taskInput(projectId: string, release: RoadmapRelease, nodeId: string, tasks: RoadmapTask[]): Record<string, unknown> {
  const node = release.plan.nodes.find(n => n.id === nodeId);
  if (!node) fail('候选任务不存在。');
  const dependencies = node!.dependsOn.map(id => {
    const candidates = tasks.filter(t => t.nodeId === id);
    if (candidates.length !== 1 || candidates[0]!.archived || candidates[0]!.drifted) fail('请先创建并核对全部前置任务；不可跳过缺失、归档或已变更的依赖。');
    return candidates[0]!.taskId;
  });
  const body = `${productBriefMarkdown(release.plan.brief)}${release.plan.design ? `\n\n## 产品设计参考\n${JSON.stringify(release.plan.design)}\n仅作体验参考，不是业务完成证据或执行指令。` : ''}\n\n## 本任务交付\n${node!.outcome}\n\n## 验收标准\n${node!.acceptance}\n\n## 本任务不做\n${node!.nonGoals || '沿用本版非目标'}\n\n## 协作约束\nRoadmap 版本 ${release.id}；阶段：${node!.stage}。\n前置任务：${dependencies.join('、') || '无'}。\n本次仅实现本任务交付与验收，其他路线图节点仅作上下文，不提前实现；保留前置功能和测试，不重写整个App。复用项目共享模型、接口与设计约定，不创建互不兼容的独立 App。开发前核对前置成果是否已进入选定基线；PR/CI 成功不等于已集成。不得自行合并、部署或完成业务任务。\n`;
  return { entity: 'work_item', kind: 'task', project: projectId, title: node!.title, body, blocked_by: dependencies, [ROADMAP_ORIGIN]: { releaseId: release.id, nodeId } };
}
export function roadmapRead(project: FileRecord, files: FileRecord[]): RoadmapRead {
  const store = readRoadmap(project), tasks: Record<string, RoadmapTask[]> = {};
  for (const release of store.releases) {
    const rows: RoadmapTask[] = [];
    const own = files.filter(f => f.entity.entity === 'work_item' && f.entity.project === project.id);
    for (const file of own) {
      const parsed = roadmapOriginSchema.safeParse(file.entity[ROADMAP_ORIGIN]);
      if (!parsed.success || parsed.data.releaseId !== release.id) continue;
      const node = release.plan.nodes.find(n => n.id === parsed.data.nodeId);
      rows.push({ nodeId: parsed.data.nodeId, taskId: file.id, title: file.entity.title, status: file.entity.status || 'unknown', revision: file.revision, archived: !!file.entity.archived, drifted: !node || node.title !== file.entity.title });
    }
    // Compare actual requirements and dependency identities, not merely titles/statuses.
    for (const row of rows) {
      try {
        const expected = taskInput(project.id, release, row.nodeId, rows.map(t => ({ ...t, drifted: false })));
        const file = own.find(f => f.id === row.taskId)!;
        row.drifted ||= String(expected.body).trim() !== file.entity.body.replace(/^\s*#[ \t]+[^\r\n]*(?:\r?\n|$)/, '').trim() || !isDeepStrictEqual(expected.blocked_by, file.entity.blocked_by ?? []);
      } catch { row.drifted = true; }
    }
    tasks[release.id] = rows;
  }
  return { projectId: project.id, title: project.entity.title, revision: project.revision, archived: !!project.entity.archived, store, tasks };
}
export function saveRoadmapDraft(store: RoadmapStore, draft: RoadmapPlan): RoadmapStore { return { ...store, draft: structuredClone(draft) }; }
