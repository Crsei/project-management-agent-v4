import { canvasHandoffSchema } from '../../../../../packages/contracts/src/task-context.ts';
import { readProductReport } from './report.ts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { canvasStartSchema, canvasControlSchema, canvasScopeSchema, type CanvasRun, type CanvasScope } from '../../../../../packages/contracts/src/product-canvas.ts';
import { roadmapStoreSchema, type RoadmapRead } from '../../../../../packages/contracts/src/product-roadmap.ts';
import { pmToolCapabilitiesSchema } from '../../../../../packages/agent-contracts/src/pm-capabilities.ts';
import { ProductCanvasService } from '../../../../../packages/application/src/product-canvas.ts';
import { DeliveryError } from '../../../../../packages/application/src/task-code-delivery.ts';
import { DurableError } from '../durable/errors.ts';
import { listRecords, readRecord, writeRecord, transaction } from '../durable/store.ts';
import { resolveAgentScope } from '../durable/agent-scope.ts';
import { resolveProviderRuntime } from '../providers/runtime.ts';
import { requestDeliveryPm, authorizeDelivery } from '../task-delivery/authority.ts';
import { deliveryStore, deliveryTaskRevision } from '../task-delivery/binding.ts';
import { confirmedDelivery, inspectRoadmapDelivery } from '../task-delivery/roadmap.ts';
import { git, githubRepository } from '../task-delivery/git.ts';
import { DeliveryGitHub } from '../task-delivery/github.ts';
import { workflowService } from '../task-workflows/service.ts';
import { workflowStore } from '../task-workflows/store.ts';
import { scheduleWorkflow, assertWorkflowRunner } from '../task-workflows/runner.ts';
const bucket = 'product-canvas-runs-v1', locks = new Set<string>();
const store = {
  read: (id: string) => readRecord<CanvasRun>(bucket, id), list: () => listRecords<CanvasRun>(bucket),
  save: (r: CanvasRun) => transaction(() => {
    const old = readRecord<CanvasRun>(bucket, r.id);
    if ((old?.version ?? 0) !== r.version - 1 || (!old && listRecords<CanvasRun>(bucket).some(v => v.input.workspaceId === r.input.workspaceId && v.input.projectId === r.input.projectId && (v.input.releaseId === r.input.releaseId || v.status !== 'completed')))) throw new DurableError(409, 'canvas_conflict', '项目已有运行或版本已变化。');
    writeRecord(bucket, r.id, r);
  }),
};
const endpoint = (s: CanvasScope) => `/api/v1/workspaces/${s.workspaceId}/projects/${encodeURIComponent(s.projectId)}/product-roadmap`;
async function project(s: CanvasScope, headers: Headers, write: boolean): Promise<RoadmapRead> {
  const data = await requestDeliveryPm(endpoint(s), headers);
  const parsed = z.object({ projectId: z.string(), revision: z.string(), archived: z.boolean(), store: roadmapStoreSchema, tasks: z.record(z.string(), z.array(z.object({ nodeId: z.uuid(), taskId: z.string(), revision: z.string(), drifted: z.boolean(), archived: z.boolean() }))) }).parse(data);
  if (parsed.projectId !== s.projectId || parsed.archived) throw new DurableError(409, 'canvas_project', '项目不可用或已归档。');
  if (write) { const caps = pmToolCapabilitiesSchema.parse(await requestDeliveryPm(`/api/v1/workspaces/${s.workspaceId}/agent-capabilities?projectId=${encodeURIComponent(s.projectId)}`, headers)); if (!caps.tools.some(t => t.name === 'pm_update_task' && t.allowed)) throw new DurableError(403, 'canvas_denied', '缺少项目规划编辑权限。'); }
  return data as RoadmapRead;
}
async function repository(s: CanvasScope, headers: Headers) {
  const area = await resolveAgentScope({ workspaceId: s.workspaceId, projectId: s.projectId }, headers), remote = (await git(area.path, 'remote', 'get-url', 'origin')).trim();
  if ((await git(area.path, 'remote', 'get-url', '--push', 'origin')).trim() !== remote) throw new Error('origin 读写地址不一致。');
  const repo = githubRepository(remote);
  let base = ''; try { base = (await git(area.path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).trim().replace(/^origin\//, ''); } catch { const refs = (await git(area.path, 'for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin')).trim().split('\n'); base = refs.includes('main') ? 'main' : refs.includes('master') ? 'master' : ''; }
  return { repository: `${repo.owner}/${repo.repo}`, baseBranch: base };
}
function service(headers: Headers) {
  return new ProductCanvasService({ ...store,
    project: (s, write) => project(s, headers, write),
    preflight: async input => {
      if ((await repository(input, headers)).repository !== input.repository) throw new Error('仓库已变化。');
      const provider = await resolveProviderRuntime({ providerInstanceId: input.providerInstanceId, modelName: input.model });
      if (provider.driver !== 'codex') throw new Error('当前画布写入仅支持已确认的 Codex worktree 策略。');
    },
    materialize: async (s, releaseId, nodeId) => { await requestDeliveryPm(endpoint(s), headers, { action: 'materialize', releaseId, nodeId, confirm: true }); },
    child: async id => workflowStore.readRun(id) ? workflowService(headers).read(id) : null,
    existing: async (s, taskId) => {
      const catalog = await workflowService(headers).catalog({ ...s, taskId });
      if (catalog.hasManualDelivery) throw new Error('节点存在手动交付，需要先核对，不能另建执行链。');
      return catalog.runs[0] ?? null;
    },
    startChild: async (r, n, taskRevision, baseBranch) => {
      const child = await workflowService(headers).start({ id: n.childId, workspaceId: r.input.workspaceId, projectId: r.input.projectId, taskId: n.taskId!, taskRevision, baseBranch, repository: r.input.repository, providerInstanceId: r.input.providerInstanceId, model: r.input.model, definitionId: 'builtin-canvas-deliver', definitionVersion: 1, consent: { execute: true, worktreeWrite: true, commit: true, push: true, draftPr: true, taskStatus: true } });
      scheduleWorkflow(child.id, headers); return child;
    },
    controlChild: async (id, action, version) => { const child = await workflowService(headers).control(id, action, version); if (action === 'resume') scheduleWorkflow(child.id, headers); },
    verifyChild: async (id, input) => {
      const d = deliveryStore.read(id); if (!d?.git || !d.head || d.workspaceId !== input.workspaceId || d.projectId !== input.projectId) throw new Error('缺少节点交付记录。');
      const current = await authorizeDelivery(d, false, headers);
      if (current.revision !== deliveryTaskRevision(d) || current.root !== d.git.root || `${d.git.owner}/${d.git.repo}` !== input.repository) throw new Error('节点版本或仓库变化。');
      const feedback = await new DeliveryGitHub().feedback(d);
      if (!confirmedDelivery({ ...d, feedback })) throw new Error('节点最新测试或同版本 CI 未通过。');
      const files = (await git(d.git.directory, 'diff', '--name-only', '-z', `${d.git.baseSha}..${d.head}`)).split('\0').filter(Boolean);
      const report = await readProductReport(d.git.directory, d.head, d.taskId, files);
      const handoff = canvasHandoffSchema.parse({ schema:'pm/task-handoff/v1',deliveryId:d.id,taskId:d.taskId,head:d.head,branch:d.git.branch,pr:d.pr!.url,testCommand:d.test!.command,testDigest:d.test!.outputDigest,ci:feedback.checks.map(c=>c.name),checkedAt:feedback.observedAt,files:files.slice(0,100),filesTruncated:files.length>100,...(report ? { report } : {}) });
      return { branch: d.git.branch, handoff };
    },
    integration: async r => (await inspectRoadmapDelivery({ ...r.input }, headers, true)).eligible,
  }, locks);
}
const sessions = new Map<string, Headers>(); let enabled = false, timer: ReturnType<typeof setTimeout> | undefined, pumping: Promise<void> | undefined;
function schedule(id: string, headers: Headers) { const auth = new Headers(); for (const k of ['cookie', 'authorization']) { const v = headers.get(k); if (v) auth.set(k, v); } sessions.set(id, auth); }
export function startProductCanvases() {
  if (enabled) return;
  for (const r of store.list()) if (r.status === 'running') store.save({ ...r, version: r.version + 1, status: 'paused', updatedAt: new Date().toISOString(), message: '服务已重启，请明确继续；先核对原请求，不重放副作用。' });
  enabled = true;
  const loop = () => { if (!enabled) return; pumping = (async () => { for (const [id, headers] of sessions) { if (!enabled) break; try { const r = await service(headers).tick(id); if (r.status !== 'running') sessions.delete(id); } catch { /* CAS/busy: next tick re-reads, never replays effects. */ } } })().finally(() => { pumping = undefined; if (enabled) { timer = setTimeout(loop, 3000); timer.unref(); } }); };
  timer = setTimeout(loop, 750); timer.unref();
}
export async function stopProductCanvases() { enabled = false; if (timer) clearTimeout(timer); await pumping; sessions.clear(); }
const assertRunner = () => { assertWorkflowRunner(); if (!enabled) throw new DurableError(503, 'canvas_offline', '画布执行器未启动。'); };
export const productCanvasRoutes = new Hono();
productCanvasRoutes.use('/product-canvases/*', bodyLimit({ maxSize: 64 * 1024 }));
productCanvasRoutes.onError((e, c) => c.json({ error: e instanceof DurableError || e instanceof DeliveryError ? e.message : '画布请求失败，请核对配置与原执行记录。' }, e instanceof DurableError ? e.status : e instanceof z.ZodError ? 400 : 409));
productCanvasRoutes.get('/product-canvases', async c => {
  const scope = canvasScopeSchema.parse(c.req.query()); await project(scope, c.req.raw.headers, false);
  let setup: { repository: string; baseBranch: string } | null = null; try { setup = await repository(scope, c.req.raw.headers); } catch { /* No implicit repository or scope fallback. */ }
  return c.json({ setup, runs: store.list().filter(r => r.input.workspaceId === scope.workspaceId && r.input.projectId === scope.projectId), ready: enabled });
});
productCanvasRoutes.post('/product-canvases/runs', async c => { assertRunner(); const r = await service(c.req.raw.headers).start(canvasStartSchema.parse(await c.req.json())); if (r.status === 'running') schedule(r.id, c.req.raw.headers); return c.json(r); });
productCanvasRoutes.get('/product-canvases/runs/:id', async c => c.json(await service(c.req.raw.headers).read(z.uuid().parse(c.req.param('id')))));
productCanvasRoutes.post('/product-canvases/runs/:id/control', async c => { assertRunner(); const v = canvasControlSchema.parse(await c.req.json()); const r = await service(c.req.raw.headers).control(z.uuid().parse(c.req.param('id')), v.action, v.version); if (r.status === 'running') schedule(r.id, c.req.raw.headers); return c.json(r); });
