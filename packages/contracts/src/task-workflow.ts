import { z } from 'zod';
import { deliveryScopeSchema } from './task-code-delivery.ts';

export const workflowKinds = ['task', 'prepare', 'agent', 'test', 'condition', 'commit', 'push', 'pr', 'ci', 'approval', 'end'] as const;
export type WorkflowKind = typeof workflowKinds[number];
export const workflowLabels: Record<WorkflowKind, string> = { task: '任务输入', prepare: '准备独立环境', agent: 'Agent 开发 / 分析', test: '执行测试', condition: '结果判断', commit: '提交代码', push: '推送分支', pr: '创建 Draft PR', ci: '等待 CI', approval: '人工确认', end: '结束' };
const nodeId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/).refine(value => !Object.hasOwn(Object.prototype, value), '保留 ID 不可用');
export const taskTransitionSchema = z.strictObject({ phase: z.enum(['start', 'review']), mode: z.enum(['auto', 'confirm']) });
export const workflowTransitionRequestSchema = deliveryScopeSchema.extend({ runId: z.uuid(), nodeId, revision: z.string().min(1).max(256), phase: z.enum(['start', 'review']) });
export type WorkflowTransitionRequest = z.infer<typeof workflowTransitionRequestSchema>;
export type WorkflowTransitionResult = { status: 'applied'; revision: string; commandId: string } | { status: 'not_found' | 'pending' };
export type WorkflowTransitionRecord = { phase: 'start' | 'review'; mode: 'auto' | 'confirm'; state: 'awaiting' | 'requested' | 'applied'; request?: WorkflowTransitionRequest; revision?: string; commandId?: string; confirmedAt?: string; appliedAt?: string; message?: string };
export const workflowGraphSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  nodes: z.array(z.strictObject({ id: nodeId, kind: z.enum(workflowKinds), label: z.string().trim().min(1).max(100),
    x: z.number().finite().min(-10000).max(10000), y: z.number().finite().min(-10000).max(10000),
    config: z.strictObject({ mode: z.enum(['analyze', 'develop']).optional(), instruction: z.string().max(8000).optional(), command: z.string().trim().max(2000).optional(), source: z.enum(['test', 'ci']).optional(), timeoutMinutes: z.number().int().min(1).max(60).optional(), requiredChecks: z.array(z.string().trim().min(1).max(150)).min(1).max(20).optional(), outcome: z.enum(['success', 'failure']).optional(), taskTransition: taskTransitionSchema.optional() }),
  })).min(2).max(32),
  edges: z.array(z.strictObject({ id: nodeId, source: nodeId, target: nodeId, port: z.enum(['next', 'pass', 'fail']) })).max(64),
});
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;
export type WorkflowNode = WorkflowGraph['nodes'][number];
export type WorkflowDefinition = { id: string; workspaceId: string; projectId: string; revision: number; draft: WorkflowGraph; versions: { version: number; graph: WorkflowGraph; publishedAt: string }[] };
export const workflowSaveSchema = deliveryScopeSchema.extend({ id: z.uuid(), expectedRevision: z.number().int().nonnegative(), graph: workflowGraphSchema, publish: z.boolean() });
export const workflowStartSchema = deliveryScopeSchema.extend({ id: z.uuid(), taskRevision: z.string().min(1).max(256), definitionId: z.string().min(1).max(100), definitionVersion: z.number().int().positive(),
  baseBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/), repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  providerInstanceId: z.string().min(1).max(256), model: z.string().min(1).max(256),
  consent: z.strictObject({ execute: z.literal(true), worktreeWrite: z.boolean(), commit: z.boolean(), push: z.boolean(), draftPr: z.boolean(), taskStatus: z.boolean().optional() }),
});
export type WorkflowStart = z.infer<typeof workflowStartSchema>;
export type WorkflowNodeRecord = { state: 'running' | 'waiting' | 'succeeded' | 'failed'; startedAt: string; finishedAt?: string; outcome?: 'pass' | 'fail'; message?: string; generationKey?: string };
export type WorkflowRun = { id: string; version: number; input: WorkflowStart; projectRoot: string; graph: WorkflowGraph; status: 'running' | 'waiting' | 'paused' | 'completed' | 'failed'; current: string; nodes: Record<string, WorkflowNodeRecord>; createdAt: string; updatedAt: string; message?: string; acceptedTaskRevision?: string; transitions?: Record<string, WorkflowTransitionRecord> };
export const workflowTaskRevision = (run: WorkflowRun) => run.acceptedTaskRevision ?? run.input.taskRevision;
export const workflowControlSchema = z.strictObject({ action: z.enum(['resume', 'pause', 'approve', 'confirm-transition']), version: z.number().int().positive(), confirm: z.literal(true) });

/** Same validation for canvas and execution. No eval, arbitrary conditions or unbounded loops. */
export function workflowProblems(graph: WorkflowGraph): string[] {
  const errors: string[] = [], ids = new Set(graph.nodes.map(n => n.id));
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  if (ids.size !== graph.nodes.length) errors.push('节点 ID 重复。');
  if (new Set(graph.edges.map(e => e.id)).size !== graph.edges.length) errors.push('连线 ID 重复。');
  const starts = graph.nodes.filter(n => n.kind === 'task');
  if (starts.length !== 1) errors.push('必须有且只有一个任务输入。');
  if (!graph.nodes.some(n => n.kind === 'end')) errors.push('至少需要一个结束节点。');
  for (const kind of ['prepare', 'agent', 'test', 'commit', 'push', 'pr', 'ci'] as const) {
    if (graph.nodes.filter(n => n.kind === kind).length > 1) errors.push(`${workflowLabels[kind]}首版只允许一个。`);
  }
  for (const edge of graph.edges) if (!ids.has(edge.source) || !ids.has(edge.target)) errors.push('连线引用不存在的节点。');
  for (const n of graph.nodes) {
    const edges = graph.edges.filter(e => e.source === n.id);
    const ports = n.kind === 'end' ? [] : n.kind === 'condition' ? ['pass', 'fail'] : ['next'];
    if (edges.length !== ports.length || ports.some(p => edges.filter(e => e.port === p).length !== 1)) errors.push(`${n.label}的出口必须为 ${ports.join(' / ') || '无'}。`);
    if (n.kind === 'task' && graph.edges.some(e => e.target === n.id)) errors.push('任务输入不能有入边。');
    if (n.kind === 'agent' && !n.config.mode) errors.push(`${n.label}需要选择分析或开发。`);
    if (n.kind === 'test' && !n.config.command?.trim()) errors.push(`${n.label}需要测试命令。`);
    if (n.kind === 'condition' && !n.config.source) errors.push(`${n.label}需要判断来源。`);
    if (n.kind === 'end' && !n.config.outcome) errors.push(`${n.label}需要结束结果。`);
    const allowed: Partial<Record<WorkflowKind, string[]>> = { agent: ['mode', 'instruction', 'taskTransition'], test: ['command'], condition: ['source'], ci: ['timeoutMinutes', 'taskTransition', 'requiredChecks'], end: ['outcome'], approval: ['instruction'] };
    if (n.config.taskTransition && !(n.kind === 'agent' && n.config.mode === 'develop' && n.config.taskTransition.phase === 'start' || n.kind === 'ci' && n.config.taskTransition.phase === 'review')) errors.push(`${n.label}的状态联动仅支持进入开发或 CI 通过后待审核。`);
    if (Object.keys(n.config).some(key => !(allowed[n.kind] ?? []).includes(key))) errors.push(`${n.label}存在不适用的配置。`);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const walk = (id: string) => {
    if (visiting.has(id)) { errors.push('第一版不允许循环。'); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const e of graph.edges.filter(e => e.source === id)) if (ids.has(e.target)) walk(e.target);
    visiting.delete(id); visited.add(id);
  };
  if (starts[0]) walk(starts[0].id);
  if (visited.size !== ids.size) errors.push('存在从任务输入不可达的节点。');
  if (errors.length) return [...new Set(errors)];
  // Enumerate bounded path states; predecessors must hold on EVERY incoming path.
  const states = new Set<string>();
  const check = (id: string, seen: Set<string>) => {
    const key = `${id}:${[...seen].sort().join(',')}`;
    if (states.has(key)) return; states.add(key);
    if (states.size > 512) { errors.push('条件组合过多，请简化工作流。'); return; }
    const n = byId.get(id)!;
    const needs: Partial<Record<WorkflowKind, string>> = { agent: 'prepare', test: 'develop', commit: 'test', push: 'commit', pr: 'push', ci: 'pr' };
    const need = n.kind === 'condition' ? n.config.source : needs[n.kind];
    if (need && !seen.has(need)) errors.push(`${n.label}的所有路径必须先经过 ${need}。`);
    const next = new Set(seen); next.add(n.kind);
    if (n.kind === 'agent' && n.config.mode === 'develop') next.add('develop');
    if (n.kind === 'end' && n.config.outcome === 'success' && !seen.has('agent')) errors.push('成功结束前必须经过 Agent。');
    for (const e of graph.edges.filter(e => e.source === id)) check(e.target, next);
  };
  check(starts[0]!.id, new Set());
  return [...new Set(errors)];
}

function template(id: string, name: string, kinds: WorkflowKind[]): WorkflowDefinition {
  const nodes: WorkflowNode[] = kinds.map((kind, i) => ({ id: `${kind}${i}`, kind, label: workflowLabels[kind], x: 100 + (i % 4) * 270, y: 80 + Math.floor(i / 4) * 170,
    config: kind === 'agent' ? { mode: id === 'builtin-analysis' ? 'analyze' : 'develop' } : kind === 'test' ? { command: 'npm test' } : kind === 'ci' ? { timeoutMinutes: 15 } : kind === 'end' ? { outcome: 'success' } : {} }));
  const graph: WorkflowGraph = { name, nodes, edges: nodes.slice(0, -1).map((n, i) => ({ id: `edge${i}`, source: n.id, target: nodes[i + 1]!.id, port: 'next' })) };
  return { id, workspaceId: '', projectId: '', revision: 1, draft: graph, versions: [{ version: 1, graph, publishedAt: '2026-10-31T00:00:00.000Z' }] };
}
export const workflowTemplates: WorkflowDefinition[] = [
  template('builtin-analysis', '需求分析', ['task', 'prepare', 'agent', 'end']),
  template('builtin-validate', '开发并验证', ['task', 'prepare', 'agent', 'test', 'end']),
  template('builtin-deliver', '开发并交付', ['task', 'prepare', 'agent', 'test', 'commit', 'push', 'pr', 'ci', 'end']),
];
// Keep v1 immutable so existing starts and persisted graphs retain their original meaning.
for (const definition of workflowTemplates.filter(d => d.id !== 'builtin-analysis')) {
  const graph = structuredClone(definition.draft);
  for (const node of graph.nodes) {
    if (node.kind === 'agent') node.config.taskTransition = { phase: 'start', mode: 'auto' };
    if (node.kind === 'ci') node.config.taskTransition = { phase: 'review', mode: 'confirm' };
  }
  definition.draft = graph; definition.revision = 2;
  definition.versions.push({ version: 2, graph, publishedAt: '2026-11-01T00:00:00.000Z' });
}

// Version 3 pins explicit CI names. Historical v1/v2 snapshots remain unchanged.
const deliveryTemplate = workflowTemplates.find(d => d.id === 'builtin-deliver')!;
const explicitCiGraph = structuredClone(deliveryTemplate.draft);
explicitCiGraph.nodes.find(n => n.kind === 'ci')!.config.requiredChecks = ['test'];
deliveryTemplate.draft = explicitCiGraph; deliveryTemplate.revision = 3;
deliveryTemplate.versions.push({ version: 3, graph: explicitCiGraph, publishedAt: '2026-11-01T15:00:00.000Z' });
