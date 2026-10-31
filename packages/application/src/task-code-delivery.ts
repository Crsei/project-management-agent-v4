import type { DeliveryAction, DeliveryFeedback, DeliveryGit, DeliveryScope, DeliveryTree, TaskCodeDelivery } from '../../contracts/src/task-code-delivery.ts';

export class DeliveryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export type DeliveryTask = DeliveryScope & { revision: string; title: string; description: string; root: string };
export interface DeliveryPorts {
  read(id: string): TaskCodeDelivery | null;
  list(): TaskCodeDelivery[];
  save(value: TaskCodeDelivery): void;
  authorize(scope: DeliveryScope, write: boolean): Promise<DeliveryTask>;
  preflightPrepare?(root: string, baseBranch: string): Promise<void>;
  preflightAction?(value: TaskCodeDelivery, action: DeliveryAction): Promise<void>;
  reconcileCommit?(value: TaskCodeDelivery): Promise<string | null>;
  prepare(value: TaskCodeDelivery, root: string, baseBranch: string): Promise<DeliveryGit>;
  verify(value: TaskCodeDelivery): Promise<void>;
  tree(value: TaskCodeDelivery): Promise<DeliveryTree>;
  develop(value: TaskCodeDelivery, provider: string, model: string): Promise<string>;
  generation(value: TaskCodeDelivery): { id: string; status: string } | null;
  busy(value: TaskCodeDelivery): boolean;
  test(value: TaskCodeDelivery, command: string): Promise<{ exitCode: number | null; outputDigest: string }>;
  commit(value: TaskCodeDelivery): Promise<string>;
  push(value: TaskCodeDelivery): Promise<void>;
  remoteHead(value: TaskCodeDelivery): Promise<string | null>;
  findPr(value: TaskCodeDelivery): Promise<{ number: number; url: string } | null>;
  createPr(value: TaskCodeDelivery): Promise<{ number: number; url: string }>;
  feedback(value: TaskCodeDelivery): Promise<DeliveryFeedback>;
}
const fail = (code: string, message: string): never => { throw new DeliveryError(code, message); };
/** Application-owned delivery workflow. Never transitions the PM task or infers completion. */
export class TaskCodeDeliveryService {
  private readonly active: Set<string>;
  private readonly ports: DeliveryPorts;
  constructor(ports: DeliveryPorts, active = new Set<string>()) { this.ports = ports; this.active = active; }
  private async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.active.has(key)) fail('delivery_busy', '交付步骤正在执行，请先读取当前结果。');
    this.active.add(key);
    try { return await work(); } finally { this.active.delete(key); }
  }
  private save(value: TaskCodeDelivery): TaskCodeDelivery {
    value.updatedAt = new Date().toISOString(); value.version += 1; this.ports.save(value); return value;
  }
  async list(scope: DeliveryScope): Promise<TaskCodeDelivery[]> {
    await this.ports.authorize(scope, false);
    return this.ports.list().filter(v => v.workspaceId === scope.workspaceId && v.projectId === scope.projectId && v.taskId === scope.taskId);
  }
  async prepare(input: DeliveryScope & { id: string; taskRevision: string; baseBranch: string }): Promise<TaskCodeDelivery> {
    return this.exclusive(`${input.workspaceId}:${input.taskId}`, async () => {
      const task = await this.ports.authorize(input, true);
      const old = this.ports.read(input.id);
      if (old) {
        if (old.workspaceId !== input.workspaceId || old.projectId !== input.projectId || old.taskId !== input.taskId || old.taskRevision !== input.taskRevision || old.baseBranch !== input.baseBranch)
          fail('idempotency_conflict', '原请求已存在，不能更换范围或输入重放。');
        return old;
      }
      if (task.revision !== input.taskRevision) fail('task_changed', '任务已更新，请先重新读取需求。');
      if (this.ports.list().some(v => v.workspaceId === input.workspaceId && v.taskId === input.taskId)) fail('delivery_exists', '第一版每个任务只允许一条交付链，请继续或核对已有记录。');
      await this.ports.preflightPrepare?.(task.root, input.baseBranch);
      const now = new Date().toISOString();
      const value: TaskCodeDelivery = { ...input, title: task.title, description: task.description, threadId: `delivery-${input.id}`, createdAt: now, updatedAt: now, version: 0, step: 'preparing', pending: { action: 'prepare', at: now } };
      this.save(value);
      try { value.git = await this.ports.prepare(value, task.root, input.baseBranch); value.step = 'ready'; delete value.pending; }
      catch { value.error = '分支准备未确认。未自动重放或删除任何工作目录，请先人工核对。'; }
      return this.save(value);
    });
  }
  async inspect(id: string): Promise<{ delivery: TaskCodeDelivery; tree: DeliveryTree | null; taskChanged: boolean }> {
    const value = this.ports.read(id) ?? fail('not_found', '交付记录不可用。');
    const task = await this.ports.authorize(value, false);
    return { delivery: value, tree: value.git ? await this.ports.tree(value) : null, taskChanged: task.revision !== value.taskRevision };
  }
  async act(id: string, input: DeliveryAction): Promise<TaskCodeDelivery> {
    return this.exclusive(id, async () => {
      const value = this.ports.read(id) ?? fail('not_found', '交付记录不可用。');
      const task = await this.ports.authorize(value, input.action !== 'refresh');
      if (input.action !== 'refresh' && task.revision !== value.taskRevision) fail('task_changed', '任务版本已改变；不能使用旧需求继续执行或发布。');
      if (!value.git) fail('prepare_unknown', '分支准备尚未确认，请人工核对原操作。');
      if (task.root !== value.git!.root) fail('project_directory_changed', '项目目录已重新绑定，停止原交付。');
      await this.ports.verify(value);
      if (input.action === 'refresh') return this.refresh(value);
      if (value.pending) fail('outcome_unknown', '原步骤尚未确认；先刷新核对，不能重放副作用。');
      if (this.ports.busy(value)) fail('agent_busy', 'Agent 仍在执行，不能同时测试或发布。');
      const tree = await this.ports.tree(value);
      if (input.action === 'develop' && !['ready', 'developed', 'tested'].includes(value.step)) fail('invalid_step', '当前交付阶段不能启动开发。');
      if (input.action === 'test' && !['developed', 'tested'].includes(value.step)) fail('invalid_step', '先完成一次 Agent 开发，再运行验证。');
      if (input.action === 'commit' && (value.step !== 'tested' || !value.test?.passed || value.test.fingerprint !== tree.fingerprint || input.fingerprint !== tree.fingerprint || !tree.files.length)) fail('stale_test', '需要与当前变更完全一致的通过测试及显式提交确认。');
      if (input.action === 'push' && (value.step !== 'committed' || tree.files.length || value.head !== tree.head || input.head !== tree.head)) fail('stale_head', '只允许推送已确认且工作区干净的提交。');
      if (input.action === 'draft-pr' && (value.step !== 'pushed' || tree.files.length || value.head !== tree.head || input.head !== tree.head)) fail('stale_head', '先推送当前已确认提交。');
      await this.ports.preflightAction?.(value, input);
      if (input.action === 'develop') {
        value.generationKey = crypto.randomUUID();
        value.worktreeWriteConfirmed = input.allowWorktreeWrite === true && input.purpose !== 'analysis';
        value.developmentPurpose = input.purpose ?? 'development';
        value.developmentInstruction = input.instruction ?? '';
      }
      value.pending = { action: input.action, at: new Date().toISOString(), head: tree.head, fingerprint: tree.fingerprint };
      delete value.error; this.save(value);
      try {
        switch (input.action) {
          case 'develop':
            value.generationId = await this.ports.develop(value, input.providerInstanceId, input.model);
            value.step = 'developing'; value.generationStatus = 'queued'; delete value.test; break;
          case 'test': {
            const result = await this.ports.test(value, input.command);
            const after = await this.ports.tree(value);
            value.test = { command: input.command, fingerprint: tree.fingerprint, passed: result.exitCode === 0 && tree.fingerprint === after.fingerprint, ...result, at: new Date().toISOString() };
            value.step = 'tested'; break;
          }
          case 'commit': value.head = await this.ports.commit(value); value.step = 'committed'; break;
          case 'push': await this.ports.push(value); value.step = 'pushed'; break;
          case 'draft-pr':
            if (await this.ports.remoteHead(value) !== value.head) fail('remote_changed', '远端分支已变化，未创建 PR。');
            value.pr = await this.ports.findPr(value) ?? await this.ports.createPr(value); value.step = 'pr'; break;
        }
        delete value.pending;
      } catch { value.error = '步骤结果尚未确认。请刷新核对原记录；不会自动重试提交、推送或创建 PR。'; }
      return this.save(value);
    });
  }
  private async refresh(value: TaskCodeDelivery): Promise<TaskCodeDelivery> {
    const op = value.pending?.action;
    if (op === 'develop' || value.step === 'developing') {
      const generation = this.ports.generation(value);
      if (generation) {
        value.generationId = generation.id; value.generationStatus = generation.status;
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(generation.status)) value.step = 'developed';
        else value.step = 'developing';
        if (op === 'develop') delete value.pending;
      }
    }
    if (op === 'commit' && this.ports.reconcileCommit) {
      const head = await this.ports.reconcileCommit(value);
      if (head) { value.head = head; value.step = 'committed'; delete value.pending; }
    }
    if (op === 'push' && await this.ports.remoteHead(value) === value.head) { value.step = 'pushed'; delete value.pending; }
    if (op === 'draft-pr') {
      const pr = await this.ports.findPr(value);
      if (pr) { value.pr = pr; value.step = 'pr'; delete value.pending; }
    }
    // Unknown tests/commits/prepares are not blindly re-executed or inferred from a clean tree.
    if (value.pr) value.feedback = await this.ports.feedback(value);
    if (!value.pending) delete value.error;
    return this.save(value);
  }
}
