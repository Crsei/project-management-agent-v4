import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as store from "../durable/store.ts";
import { listRuns } from "../durable/engine.ts";
import { DurableError } from "../durable/errors.ts";
import { continueChatRecovery, getChatRecoveryCandidate, listChatGenerations } from "../durable/chat-runtime.ts";
import { getThread } from "../durable/threads.ts";
import { resolveChatExecutionScope } from "../task-delivery/binding.ts";
import { isObject } from "../durable/validation.ts";
import { getStoredInstance } from "../providers/instances.ts";
import { AutomationError, AutomationService } from "./service.ts";

const consentHeaders = new Map<string, Headers>();
const key = Symbol.for("agent-workspace.chat-recovery-service");
const globals = globalThis as typeof globalThis & { [key]?: AutomationService };
function getAutomation(): AutomationService {
  return globals[key] ??= new AutomationService({ store, latestLegacyRun: threadId => listRuns(threadId)[0] ?? null,
    chat: { getCandidate: getChatRecoveryCandidate,
      continueRun: async (id, options) => {
        const headers = consentHeaders.get(id);
        if (!headers) throw new DurableError(412, "recovery_authorization_required", "服务重启后没有当前恢复确认；请重新确认，不会重建或重放原会话。");
        return continueChatRecovery(id, options, headers);
      },
      latestInThread: threadId => { const latest = listChatGenerations(threadId)[0]; return latest ? getChatRecoveryCandidate(latest.id) : null; } },
    providerIdentity: id => { const instance = getStoredInstance(id); return instance ? `${id}:${instance.revision}` : null; },
  });
}
export async function startAutomation(): Promise<void> { await getAutomation().start(); }
export async function stopAutomation(): Promise<void> { consentHeaders.clear(); await globals[key]?.stop(); }
async function authorizeRecovery(id: string, headers: Headers): Promise<void> {
  const candidate = getChatRecoveryCandidate(id), thread = candidate ? getThread(candidate.threadId) : null;
  if (!thread) throw new DurableError(404, "not_found", "新版 Session 的回复不存在。");
  await resolveChatExecutionScope(thread, headers, "inspect");
}
/** Current PM Automation Studio owns schedules/events/templates; no legacy resource-run aliases remain. */
export const automationRoutes = new Hono();
automationRoutes.use('/automation/*', bodyLimit({ maxSize: 4096 }));
automationRoutes.onError((error, c) => {
  if (error instanceof AutomationError) return c.json({ error: error.message, code: 'automation_request_error' }, error.status);
  if (error instanceof DurableError) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof SyntaxError) return c.json({ error: '请求体必须为有效 JSON。', code: 'invalid_request' }, 400);
  return c.json({ error: '聊天恢复操作失败；未确认原执行成功。', code: 'automation_failure' }, 503);
});
automationRoutes.get('/automation/recovery', async c => {
  const recoveries = getAutomation().recoveries().filter(record => getChatRecoveryCandidate(record.runId));
  for (const record of recoveries) await authorizeRecovery(record.runId, c.req.raw.headers);
  return c.json({ recoveries });
});
automationRoutes.put('/automation/recovery/:runId', async c => {
  const input: unknown = await c.req.json();
  if (!isObject(input) || Object.keys(input).length !== 1 || typeof input.enabled !== 'boolean') throw new AutomationError('额度恢复请求必须为 {enabled:boolean}。');
  const id = c.req.param('runId'); await authorizeRecovery(id, c.req.raw.headers);
  const recovery = getAutomation().setRecovery(id, input.enabled);
  if (input.enabled) {
    const headers = new Headers(); for (const name of ['cookie', 'authorization']) { const value = c.req.header(name); if (value) headers.set(name, value); }
    consentHeaders.set(id, headers);
  } else consentHeaders.delete(id);
  return c.json({ recovery });
});
automationRoutes.get('/automation/dispatches', async c => {
  const sourceId = c.req.query('sourceId');
  const dispatches = getAutomation().dispatches(sourceId).filter(record => record.sourceType === 'recovery' && getChatRecoveryCandidate(record.sourceId));
  for (const record of dispatches) await authorizeRecovery(record.sourceId, c.req.raw.headers);
  return c.json({ dispatches });
});
