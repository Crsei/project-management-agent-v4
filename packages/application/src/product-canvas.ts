import { buildTaskContext } from './task-context.ts';
import type { CanvasHandoff } from '../../contracts/src/task-context.ts';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { canvasOrder, canvasStartSchema, type CanvasScope, type CanvasStart, type CanvasRun } from '../../contracts/src/product-canvas.ts';
import { roadmapProblems, type RoadmapRead } from '../../contracts/src/product-roadmap.ts';
import type { WorkflowRun } from '../../contracts/src/task-workflow.ts';
import { DeliveryError } from './task-code-delivery.ts';
export interface CanvasPorts {
  read(id: string): CanvasRun | null; list(): CanvasRun[]; save(run: CanvasRun): void;
  project(scope: CanvasScope, write: boolean): Promise<RoadmapRead>;
  preflight(input: CanvasStart): Promise<void>;
  materialize(scope: CanvasScope, releaseId: string, nodeId: string): Promise<void>;
  child(id: string): Promise<WorkflowRun | null>;
  existing(scope: CanvasScope, taskId: string): Promise<WorkflowRun | null>;
  startChild(run: CanvasRun, node: CanvasRun['nodes'][number], taskRevision: string, base: string): Promise<WorkflowRun>;
  controlChild(id: string, action: 'pause' | 'resume', version: number): Promise<void>;
  verifyChild(id: string, input: CanvasStart): Promise<{ branch: string; handoff: CanvasHandoff }>;
  integration(run: CanvasRun): Promise<boolean>;
}
const fail = (message: string): never => { throw new DeliveryError('canvas_blocked', message); };
export class ProductCanvasService {
  private readonly p: CanvasPorts;
  private readonly locks: Set<string>;
  constructor(p: CanvasPorts, locks = new Set<string>()) { this.p = p; this.locks = locks; }
  private async lock<T>(key: string, work: () => Promise<T>) { if (this.locks.has(key)) fail('画布正在推进，请稍后核对。'); this.locks.add(key); try { return await work(); } finally { this.locks.delete(key); } }
  private save(r: CanvasRun) { r.version++; r.updatedAt = new Date().toISOString(); this.p.save(r); return r; }
  async read(id: string) { const r = this.p.read(id) ?? fail('画布运行不存在。'); await this.p.project(r.input, false); return r; }
  async start(input: CanvasStart) {
    input = canvasStartSchema.parse(input);
    return this.lock(`${input.workspaceId}:${input.projectId}`, async () => {
      const project = await this.p.project(input, true), old = this.p.read(input.id);
      if (old) { if (!isDeepStrictEqual(old.input, input)) fail('启动请求参数已变化，不能重放。'); return old; }
      if (this.p.list().some(r => r.input.workspaceId === input.workspaceId && r.input.projectId === input.projectId && (r.input.releaseId === input.releaseId || r.status !== 'completed'))) fail('此项目已有画布运行，请核对或继续原运行。');
      if (project.archived || project.revision !== input.revision) fail('项目或计划已变化，请刷新核对。');
      const release = project.store.releases.find(r => r.id === input.releaseId) ?? fail('请先确认画布版本。');
      const errors = roadmapProblems(release.plan); if (errors.length) fail(errors.join('\n'));
      await this.p.preflight(input);
      const time = new Date().toISOString();
      return this.save({ id: input.id, input: structuredClone(input), plan: structuredClone(release.plan), version: 0, nodes: canvasOrder(release.plan).map(nodeId => ({ nodeId, childId: randomUUID(), phase: 'pending' })), status: 'running', message: '按依赖顺序构建；每个节点继承上一已验证分支，不自动合并。', createdAt: time, updatedAt: time });
    });
  }
  private async current(r: CanvasRun) {
    const p = await this.p.project(r.input, true);
    if (p.archived || !isDeepStrictEqual(p.store.releases.find(v => v.id === r.input.releaseId)?.plan, r.plan)) fail('运行版本已变化或项目已归档。');
    const rows = p.tasks[r.input.releaseId] ?? [];
    if (rows.some(t => t.archived || t.drifted) || new Set(rows.map(t => t.nodeId)).size !== rows.length) fail('节点任务已编辑、归档或重复；请核对，不运行过期需求。');
    return rows;
  }
  async control(id: string, action: 'pause' | 'resume', version: number) {
    return this.lock(id, async () => {
      const r = await this.read(id); await this.p.project(r.input, true);
      if (r.version !== version) fail('运行已变化，请刷新后操作。');
      if (r.status === 'completed') return r;
      // Persist the pause first; no further task may start even if child control fails.
      if (action === 'pause') {
        r.status = 'paused'; r.message = '已暂停后续派发；在途命令不保证取消。'; this.save(r);
        for (const n of r.nodes.filter(n => n.owned && n.phase === 'running')) { const c = await this.p.child(n.childId); if (c && ['running', 'waiting'].includes(c.status)) await this.p.controlChild(c.id, 'pause', c.version); }
        return r;
      }
      await this.current(r); await this.p.preflight(r.input);
      for (const n of r.nodes.filter(n => n.phase === 'running' || n.phase === 'starting')) {
        const c = await this.p.child(n.childId);
        if (c && ['running', 'waiting', 'paused'].includes(c.status) && n.owned) await this.p.controlChild(c.id, 'resume', c.version);
        else if (c?.status === 'failed' || c?.status === 'paused') fail('节点原运行需人工处理，不能自动重跑。');
      }
      r.status = 'running'; r.message = '继续原画布：先核对已记录操作，不重放未知副作用。'; return this.save(r);
    });
  }
  async tick(id: string) {
    return this.lock(id, async () => {
      const r = this.p.read(id) ?? fail('运行不存在。'); if (r.status !== 'running') return r;
      try {
        const rows = await this.current(r), n = r.nodes.find(n => n.phase !== 'verified');
        if (!n) { if (!await this.p.integration(r)) fail('节点交付完成，但集成证据未通过；请核对产品版本。'); r.status = 'completed'; r.message = '画布交付已验证，可打开产品验收；不代表任务或项目业务完成。'; return this.save(r); }
        const mapping = rows.find(t => t.nodeId === n.nodeId);
        if (n.taskId && mapping?.taskId !== n.taskId) fail('节点任务映射已变化。');
        if (n.phase === 'pending' || n.phase === 'creating') {
          if (mapping) { n.taskId = mapping.taskId; n.phase = 'ready'; return this.save(r); }
          if (n.phase === 'creating') fail('任务创建结果未知且没有权威映射；不会重复创建，请核对原请求。');
          n.phase = 'creating'; this.save(r);
          await this.p.materialize(r.input, r.input.releaseId, n.nodeId);
          const created = (await this.current(r)).find(t => t.nodeId === n.nodeId) ?? fail('未查到创建后的任务映射。');
          n.taskId = created.taskId; n.phase = 'ready'; return this.save(r);
        }
        if (n.phase === 'ready') {
          const existing = await this.p.existing(r.input, n.taskId!);
          if (existing) { n.childId = existing.id; n.owned = false; n.phase = 'running'; return this.save(r); }
          let base = r.input.baseBranch;
          for (const previous of r.nodes.filter(v => v.phase === 'verified')) {
            const proof = await this.p.verifyChild(previous.childId, r.input);
            if (previous.handoff && previous.handoff.head !== proof.handoff.head) fail('前置成果提交已变化，不能沿用旧上下文。');
            previous.handoff = proof.handoff; previous.branch = proof.branch; base = proof.branch;
          }
          n.context = buildTaskContext(r, n, base);
          n.baseBranch = base; n.owned = true; n.phase = 'starting'; this.save(r);
          const child = await this.p.startChild(r, n, mapping!.revision, base);
          if (child.id !== n.childId) fail('节点执行身份不一致。');
          n.phase = 'running'; return this.save(r);
        }
        if (n.phase === 'starting') {
          const child = await this.p.child(n.childId);
          if (!child) fail('节点启动结果未知，未查到原运行；不会重放启动。');
          n.phase = 'running'; return this.save(r);
        }
        const child = await this.p.child(n.childId) ?? fail('节点运行不可用。');
        n.message = child.message || child.status;
        if (child.status === 'failed' || child.status === 'paused') fail(`节点需要处理：${child.message || child.status}`);
        if (child.status === 'completed') { const proof = await this.p.verifyChild(child.id, r.input); n.branch = proof.branch; n.handoff = proof.handoff; n.phase = 'verified'; r.message = '本节点测试与交付已验证，继续下一节点。'; }
        else r.message = `正在构建：${r.plan.nodes.find(v => v.id === n.nodeId)?.title ?? n.taskId}${child.message ? ` · ${child.message}` : ''}`;
        return this.save(r);
      } catch (error) {
        r.status = 'paused'; r.message = error instanceof Error ? error.message : '执行结果待核对。'; this.save(r);
        // Stop further owned child steps after recording the parent pause. In-flight commands
        // are not cancelled; revoked authority may prevent this control, so child guards remain mandatory.
        for (const n of r.nodes.filter(n => n.owned && (n.phase === 'running' || n.phase === 'starting'))) {
          try { const child = await this.p.child(n.childId); if (child && ['running','waiting'].includes(child.status)) await this.p.controlChild(child.id, 'pause', child.version); }
          catch { /* Parent stays paused; never substitute another actor or replay an effect. */ }
        }
        return r;
      }
    });
  }
}
