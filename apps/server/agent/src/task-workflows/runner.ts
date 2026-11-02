import { workflowStore } from './store.ts';
import { workflowService } from './service.ts';
import { DurableError } from '../durable/errors.ts';

// PM credentials are request-local capabilities, never serialized into workflow records.
const sessions = new Map<string, Headers>();
let enabled = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let pumping: Promise<void> | undefined;
export function assertWorkflowRunner() { if (!enabled) throw new DurableError(503, 'workflow_offline', '工作流执行器尚未启动。'); }
export function scheduleWorkflow(id: string, headers: Headers) {
  assertWorkflowRunner();
  const auth = new Headers();
  for (const key of ['cookie', 'authorization']) { const value = headers.get(key); if (value) auth.set(key, value); }
  sessions.set(id, auth);
}
async function pump() {
  for (const [id, headers] of sessions) {
    if (!enabled) break;
    const before = workflowStore.readRun(id);
    if (!before || ['paused', 'completed', 'failed'].includes(before.status)) { sessions.delete(id); continue; }
    try {
      const after = await workflowService(headers).tick(id);
      if (['paused', 'completed', 'failed'].includes(after.status)) sessions.delete(id);
    } catch {
      // Busy/CAS are re-read next tick; do not repeat an effect here.
    }
  }
}
export function startTaskWorkflows() {
  if (enabled) return;
  for (const v of workflowStore.runs()) {
    if (v.status !== 'running' && v.status !== 'waiting') continue;
    workflowStore.saveRun({ ...v, version: v.version + 1, updatedAt: new Date().toISOString(), status: 'paused', message: '服务已重启。请登录后显式恢复；仅核对原执行，不重放未知副作用。' });
  }
  enabled = true;
  const loop = () => {
    if (!enabled) return;
    pumping = pump().finally(() => { pumping = undefined; if (enabled) { timer = setTimeout(loop, 2500); timer.unref(); } });
  };
  timer = setTimeout(loop, 500); timer.unref();
}
export async function stopTaskWorkflows() {
  enabled = false; if (timer) clearTimeout(timer); timer = undefined;
  await pumping; sessions.clear();
}
