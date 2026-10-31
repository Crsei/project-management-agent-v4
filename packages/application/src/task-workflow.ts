import type { DeliveryScope, TaskCodeDelivery } from '../../contracts/src/task-code-delivery.ts';
import { workflowProblems, workflowTemplates, type WorkflowDefinition, type WorkflowGraph, type WorkflowNode, type WorkflowRun, type WorkflowStart } from '../../contracts/src/task-workflow.ts';
import { DeliveryError, type DeliveryTask, type TaskCodeDeliveryService } from './task-code-delivery.ts';

export interface WorkflowPorts {
  readDefinition(id: string): WorkflowDefinition | null;
  definitions(): WorkflowDefinition[];
  saveDefinition(v: WorkflowDefinition): void;
  readRun(id: string): WorkflowRun | null;
  runs(): WorkflowRun[];
  saveRun(v: WorkflowRun): void;
  authorize(scope: DeliveryScope, write: boolean): Promise<DeliveryTask>;
  repository(root: string): Promise<string>;
  provider(input: WorkflowStart): Promise<void>;
  delivery: TaskCodeDeliveryService;
  readDelivery(id: string): TaskCodeDelivery | null;
  now?: () => number;
}
const fail = (code: string, message: string): never => { throw new DeliveryError(code, message); };
const sameProject = (a: { workspaceId: string; projectId: string }, b: { workspaceId: string; projectId: string }) => a.workspaceId === b.workspaceId && a.projectId === b.projectId;
export class TaskWorkflowService {
  private readonly p: WorkflowPorts;
  private readonly active: Set<string>;
  constructor(p: WorkflowPorts, active = new Set<string>()) { this.p = p; this.active = active; }
  private time() { return new Date(this.p.now?.() ?? Date.now()).toISOString(); }
  private save(v: WorkflowRun) { v.version++; v.updatedAt = this.time(); this.p.saveRun(v); return v; }
  private async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.active.has(id)) fail('workflow_busy', '工作流正在推进，请读取最新结果。');
    this.active.add(id); try { return await fn(); } finally { this.active.delete(id); }
  }
  async catalog(scope: DeliveryScope) {
    const task = await this.p.authorize(scope, false);
    const definitions = this.p.definitions().filter(v => sameProject(v, scope));
    let repository: string | null = null;
    try { repository = await this.p.repository(task.root); } catch { /* Template editing does not require Git readiness. */ }
    return { definitions: [...structuredClone(workflowTemplates), ...definitions], runs: this.p.runs().filter(v => sameProject(v.input, scope) && v.input.taskId === scope.taskId), repository, hasManualDelivery: (await this.p.delivery.list(scope)).some(d => !this.p.readRun(d.id)) };
  }
  async saveDefinition(input: DeliveryScope & { id: string; expectedRevision: number; graph: WorkflowGraph; publish: boolean }) {
    await this.p.authorize(input, true);
    const old = this.p.readDefinition(input.id);
    if (old && !sameProject(old, input)) fail('workflow_scope', '工作流不属于当前项目。');
    if ((old?.revision ?? 0) !== input.expectedRevision) fail('workflow_conflict', '工作流已变化，请重新读取后编辑。');
    if (input.publish) { const problems = workflowProblems(input.graph); if (problems.length) fail('workflow_invalid', problems.join('\n')); }
    if ((old?.versions.length ?? 0) >= 50 && input.publish) fail('workflow_limit', '此工作流已有 50 个发布版本，请复制新模板。');
    const value: WorkflowDefinition = { id: input.id, workspaceId: input.workspaceId, projectId: input.projectId, revision: input.expectedRevision + 1, draft: structuredClone(input.graph), versions: [...(old?.versions ?? [])] };
    if (input.publish) value.versions.push({ version: value.versions.length + 1, graph: structuredClone(input.graph), publishedAt: this.time() });
    this.p.saveDefinition(value); return value;
  }
  private graph(input: WorkflowStart) {
    const def = workflowTemplates.find(v => v.id === input.definitionId) ?? this.p.readDefinition(input.definitionId);
    if (!def || (!def.id.startsWith('builtin-') && !sameProject(def, input))) fail('workflow_missing', '工作流不可访问。');
    const version = def!.versions.find(v => v.version === input.definitionVersion);
    if (!version) fail('workflow_version', '仅能运行已发布的工作流版本。');
    return structuredClone(version!.graph);
  }
  private validateConsent(input: WorkflowStart, graph: WorkflowGraph) {
    const kinds = new Set(graph.nodes.map(n => n.kind));
    if (!input.consent.execute || (graph.nodes.some(n => n.kind === 'agent' && n.config.mode === 'develop') && !input.consent.worktreeWrite) || (kinds.has('commit') && !input.consent.commit) || (kinds.has('push') && !input.consent.push) || (kinds.has('pr') && !input.consent.draftPr)) fail('workflow_consent', '此图需要明确的执行、写入及发布授权；发布模板本身不是授权。');
  }
  async start(input: WorkflowStart) {
    return this.lock(`${input.workspaceId}:${input.taskId}`, async () => {
      const task = await this.p.authorize(input, true);
      const old = this.p.readRun(input.id);
      if (old) {
        if (JSON.stringify(old.input) !== JSON.stringify(input)) fail('workflow_conflict', '原启动请求存在，不能改变参数重放。');
        return old;
      }
      if (task.revision !== input.taskRevision) fail('task_changed', '任务版本已变化。');
      if (this.p.runs().some(v => v.input.workspaceId === input.workspaceId && v.input.taskId === input.taskId) || (await this.p.delivery.list(input)).length) fail('workflow_exists', '此任务已有运行或手动交付，请核对原记录，不创建第二条链。');
      const graph = this.graph(input), problems = workflowProblems(graph);
      if (problems.length) fail('workflow_invalid', problems.join('\n'));
      this.validateConsent(input, graph);
      if (await this.p.repository(task.root) !== input.repository) fail('repository_changed', '仓库与确认内容不一致，请重新读取。');
      await this.p.provider(input);
      const now = this.time();
      const value: WorkflowRun = { id: input.id, version: 0, input: structuredClone(input), projectRoot: task.root, graph, status: 'running', current: graph.nodes.find(n => n.kind === 'task')!.id, nodes: {}, createdAt: now, updatedAt: now };
      return this.save(value);
    });
  }
  async read(id: string) {
    const v = this.p.readRun(id) ?? fail('not_found', '工作流运行不可用。');
    await this.p.authorize(v.input, false); return v;
  }
  async control(id: string, action: 'pause' | 'resume' | 'approve', version: number) {
    return this.lock(id, async () => {
      const v = await this.read(id), task = await this.p.authorize(v.input, true);
      if (v.version !== version) fail('workflow_conflict', '运行已更新，请刷新后操作。');
      if (['completed', 'failed'].includes(v.status)) fail('workflow_terminal', '运行已结束。');
      if (action === 'pause') { v.status = 'paused'; v.message = '已暂停后续步骤；在途 Agent / 命令不会因此取消。'; return this.save(v); }
      if (task.revision !== v.input.taskRevision) fail('task_changed', '需求版本变化，不能恢复旧运行。');
      if (task.root !== v.projectRoot || await this.p.repository(task.root) !== v.input.repository) fail('repository_changed', '仓库已变化。');
      if (action === 'approve') {
        const node = v.graph.nodes.find(n => n.id === v.current)!;
        if (node.kind !== 'approval' || v.nodes[node.id]?.state !== 'waiting') fail('workflow_approval', '当前没有待确认节点。');
        this.complete(v, node, true, '用户确认继续；不代表业务审核通过。');
      } else { v.status = 'running'; delete v.message; }
      return this.save(v);
    });
  }
  private complete(v: WorkflowRun, node: WorkflowNode, pass: boolean, message: string) {
    v.nodes[node.id] = { ...v.nodes[node.id]!, state: pass ? 'succeeded' : 'failed', outcome: pass ? 'pass' : 'fail', finishedAt: this.time(), message };
    const edge = v.graph.edges.find(e => e.source === node.id && e.port === (node.kind === 'condition' ? pass ? 'pass' : 'fail' : 'next'));
    if (node.kind === 'end') { v.status = node.config.outcome === 'success' ? 'completed' : 'failed'; v.message = message; return; }
    if (!edge) fail('workflow_invalid', '运行图出口缺失。');
    const target = v.graph.nodes.find(n => n.id === edge!.target)!;
    if (!pass && node.kind !== 'condition' && !(target.kind === 'condition' && target.config.source === node.kind)) { v.status = 'failed'; v.message = message; return; }
    v.current = edge!.target; v.status = 'running'; delete v.message;
  }
  private wait(v: WorkflowRun, node: WorkflowNode, message: string) { v.nodes[node.id]!.state = 'waiting'; v.nodes[node.id]!.message = message; v.status = 'waiting'; v.message = message; }
  private unknown(v: WorkflowRun, message: string) { v.status = 'paused'; v.message = message; }
  /** One durable node step. Re-entry reconciles receipts; it never blindly repeats effects. */
  async tick(id: string) {
    return this.lock(id, async () => {
      const v = this.p.readRun(id) ?? fail('not_found', '运行不存在。');
      if (v.status !== 'running' && v.status !== 'waiting') return v;
      try {
        const task = await this.p.authorize(v.input, true);
        if (task.revision !== v.input.taskRevision) fail('task_changed', '任务版本已变化，原工作流已暂停。');
        if (task.root !== v.projectRoot || await this.p.repository(task.root) !== v.input.repository) fail('repository_changed', '仓库身份变化，原工作流已暂停。');
        this.validateConsent(v.input, v.graph);
        const node = v.graph.nodes.find(n => n.id === v.current)!;
        if (!node) fail('workflow_invalid', '运行节点不存在。');
        if (v.status === 'waiting' && node.kind === 'approval') return v;
        const existing = v.nodes[node.id];
        if (!existing) { v.nodes[node.id] = { state: 'running', startedAt: this.time() }; this.save(v); }
        let d = this.p.readDelivery(v.id);
        if (existing && d?.git && (d.pending || node.kind === 'agent' || node.kind === 'ci')) d = await this.p.delivery.act(v.id, { action: 'refresh' });
        if (d?.pending) { this.unknown(v, '原交付副作用结果未确认；仅可核对，不自动重试。'); return this.save(v); }
        switch (node.kind) {
          case 'task': this.complete(v, node, true, `固定任务版本 ${v.input.taskRevision}`); break;
          case 'prepare':
            if (!existing) d = await this.p.delivery.prepare({ workspaceId: v.input.workspaceId, projectId: v.input.projectId, taskId: v.input.taskId, id: v.id, taskRevision: v.input.taskRevision, baseBranch: v.input.baseBranch });
            if (d?.git && !d.pending) this.complete(v, node, true, `独立分支 ${d.git.branch}`);
            else this.unknown(v, '分支准备结果未知，请核对原工作目录；不会重新创建。');
            break;
          case 'agent':
            if (!existing) d = await this.p.delivery.act(v.id, { action: 'develop', providerInstanceId: v.input.providerInstanceId, model: v.input.model, ...(node.config.mode === 'develop' ? { allowWorktreeWrite: true as const } : {}), purpose: node.config.mode === 'analyze' ? 'analysis' : 'development', instruction: node.config.instruction ?? '' });
            if (!d || d.pending || !d.generationKey) this.unknown(v, 'Agent 启动结果未知，请核对原 generation。');
            else if (existing?.generationKey && existing.generationKey !== d.generationKey) this.unknown(v, 'Agent 执行身份变化，已停止推进。');
            else {
              v.nodes[node.id]!.generationKey = d.generationKey;
              if (d.generationStatus === 'completed') this.complete(v, node, true, 'Agent 执行结束；不等于验收通过。');
              else if (['failed', 'cancelled', 'interrupted'].includes(d.generationStatus ?? '')) this.complete(v, node, false, `Agent ${d.generationStatus}`);
              else this.wait(v, node, 'Agent 正在执行，关闭页面仍继续；可查看关联会话。');
            }
            break;
          case 'test':
            if (!existing) d = await this.p.delivery.act(v.id, { action: 'test', command: node.config.command!, confirm: true });
            if (d?.test && !d.pending && d.test.command === node.config.command) this.complete(v, node, d.test.passed, `验证 exit ${d.test.exitCode ?? 'unknown'} · ${d.test.fingerprint}`);
            else this.unknown(v, '验证结果未知；不会自动重跑命令。');
            break;
          case 'commit':
            if (!existing) { const { tree } = await this.p.delivery.inspect(v.id); d = await this.p.delivery.act(v.id, { action: 'commit', fingerprint: tree!.fingerprint, confirm: true }); }
            if (d?.head && !d.pending && ['committed', 'pushed', 'pr'].includes(d.step)) this.complete(v, node, true, d.head);
            else this.unknown(v, '提交结果未确认，请核对原提交。');
            break;
          case 'push':
            if (!existing) d = await this.p.delivery.act(v.id, { action: 'push', head: d!.head!, confirm: true });
            if (d && !d.pending && ['pushed', 'pr'].includes(d.step)) this.complete(v, node, true, '独立分支已推送。');
            else this.unknown(v, '推送结果未确认，请核对远端 SHA。');
            break;
          case 'pr':
            if (!existing) d = await this.p.delivery.act(v.id, { action: 'draft-pr', head: d!.head!, confirm: true });
            if (d?.pr && !d.pending) this.complete(v, node, true, d.pr.url);
            else this.unknown(v, 'PR 创建结果未确认，请核对原交付标记。');
            break;
          case 'ci': {
            if (!existing) d = await this.p.delivery.act(v.id, { action: 'refresh' });
            const f = d?.feedback;
            if (f && f.head !== d?.head) { this.unknown(v, '远端 HEAD 已变化，本次验证不覆盖新版本。'); break; }
            const checks = f?.checks ?? [];
            if (checks.length && checks.every(c => c.conclusion === 'success' && ['completed', 'success'].includes(c.status))) this.complete(v, node, true, '当前提交的全部已发现 CI 检查通过。');
            else if (checks.some(c => c.conclusion !== null && !['success', 'pending'].includes(c.conclusion))) this.complete(v, node, false, 'CI 未通过（含 skipped / neutral），请人工处理。');
            else if (Date.parse(this.time()) - Date.parse(v.nodes[node.id]!.startedAt) > (node.config.timeoutMinutes ?? 15) * 60000) this.complete(v, node, false, '等待 CI 超时；没有检查不算通过。');
            else this.wait(v, node, checks.length ? '等待 GitHub CI 结束。' : '尚未发现 CI，继续等待，不计通过。');
            break;
          }
          case 'condition': {
            const source = v.graph.nodes.find(n => n.kind === node.config.source);
            const outcome = source && v.nodes[source.id]?.outcome;
            if (!outcome) fail('workflow_condition', '判断来源尚无确定结果。');
            this.complete(v, node, outcome === 'pass', `选择 ${outcome} 分支`); break;
          }
          case 'approval': this.wait(v, node, node.config.instruction || '等待用户确认继续。'); break;
          case 'end': this.complete(v, node, node.config.outcome === 'success', node.config.outcome === 'success' ? '工作流结束，成果待审查；任务状态未改变。' : '工作流以失败结束，请人工处理。'); break;
        }
      } catch (error) {
        // No raw subprocess output / request headers / secrets in durable workflow messages.
        this.unknown(v, error instanceof DeliveryError ? error.message : '权限、网络或执行异常，已暂停。重新登录后核对原结果，不要重复启动。');
      }
      return this.save(v);
    });
  }
}
