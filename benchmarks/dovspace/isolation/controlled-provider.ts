import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FixtureHandle } from '../schemas/types.ts';

/** Deterministic HTTP model fixture. The real installed OMP owns RPC, hooks, tools and Sessions. */
export function createControlledOmpProvider(fixture: FixtureHandle): Server {
  return createServer((incoming, outgoing) => { void (async () => {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of incoming) { bytes += chunk.length; if (bytes > 12 * 1024 * 1024) throw new Error('Controlled request too large'); chunks.push(Buffer.from(chunk as Uint8Array)); }
    const input = z.object({
      model: z.literal('omp-controlled-protocol'),
      messages: z.array(z.object({ role: z.string(), content: z.unknown().optional(), tool_call_id: z.string().optional(), tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) })).optional() })),
      tools: z.array(z.object({ function: z.object({ name: z.string() }).optional() })).optional(),
    }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions' || input.model !== 'omp-controlled-protocol' || !Array.isArray(input.messages)) throw new Error('Unexpected controlled provider endpoint/model');
    const lastUser = input.messages.findLast(message => message.role === 'user'), resume = JSON.stringify(lastUser?.content).includes('OMP_CONTROLLED_RESUME');
    const calls = input.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []);
    const available = new Set((input.tools ?? []).map(tool => tool.function?.name));
    const target = fixture.targets['beacon-receipt'];
    if (!target) throw new Error('Controlled protocol requires the real seeded target');
    const explicit = { workspaceId: target.workspaceId, projectId: target.projectId };
    const read = { target: explicit, arguments: { id: target.entityId, bodyOffset: 0, bodyLimit: 12000 } };
    function tool(name: string, args: Record<string, unknown>): void {
      if (!available.has(name)) throw new Error(`Native OMP did not advertise required real tool ${name}`);
      stream(outgoing, { tool_calls: [{ index: 0, id: `controlled-${randomUUID()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
    }
    if (!resume) {
      if (calls.length === 0) { tool('pm_task_brief', { target: explicit, arguments: { projectId: target.projectId, taskId: target.entityId, revision: target.revision, stage: 'development', bodyOffset: null, bodyLimit: null } }); return; }
      if (calls.length === 1) { tool('pm_read', read); return; }
      if (calls.length === 2) {
        const returned = JSON.stringify(input.messages.filter(message => message.role === 'tool'));
        if (!returned.includes(target.revision)) throw new Error('Actual PM Host Tool did not return the original revision');
        tool('pm_update_task', { target: explicit, arguments: { id: target.entityId, revision: target.revision, title: null, description: null, assigneeId: null, priority: 'high', startDate: null, dueDate: null, labels: null } }); return;
      }
      if (calls.length === 3) { tool('pm_read', read); return; }
      if (calls.length === 4) {
        const mutation = calls.find(call => call.function.name === 'pm_update_task');
        const result = input.messages.find(message => message.role === 'tool' && message.tool_call_id === mutation?.id);
        const encoded = JSON.stringify(result?.content).replaceAll('\\"', '"');
        const operationId = /"operationId"\s*:\s*"([a-f0-9-]{36})"/.exec(encoded)?.[1];
        if (!operationId) throw new Error('Real lost-response tool result lacks original operation identity');
        tool('write', { path: 'artifacts/handoff.json', content: JSON.stringify({ workspaceId: target.workspaceId, projectId: target.projectId, targetId: target.entityId, operationId, observedRevision: target.revision, outcome: 'unknown; reconcile original receipt only', priorRead: 'pm_read after mutation; fresh Session must revalidate' }) }); return;
      }
      // Hold an actual provider stream open. Product cancellation must abort it, not finish a fake RPC turn.
      outgoing.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); outgoing.flushHeaders();
      outgoing.write(': controlled-awaiting-real-cancel\n\n');
      const timer = setInterval(() => outgoing.write(': still-awaiting-cancel\n\n'), 500);
      outgoing.once('close', () => clearInterval(timer)); return;
    }
    if (calls.length === 0) { tool('read', { path: 'artifacts/handoff.json' }); return; }
    if (calls.length === 1) { tool('pm_read', read); return; }
    if (calls.length === 2) {
      const command = `node -e 'const fs=require("node:fs");const h=JSON.parse(fs.readFileSync("artifacts/handoff.json","utf8"));if(!/^[a-f0-9-]{36}$/.test(h.operationId))throw Error("bad original identity");fetch("http://127.0.0.1:3901/bench/receipts/"+h.operationId,{redirect:"error"}).then(async r=>{if(!r.ok)throw Error("receipt rejected "+r.status);const v=await r.json();if(v.operationId!==h.operationId||v.status!=="succeeded")throw Error("unresolved original receipt");console.log(JSON.stringify(v));}).catch(e=>{console.error(e.message);process.exitCode=1;});'`;
      tool('bash', { command, timeout: 20 }); return;
    }
    stream(outgoing, { content: 'Controlled HTTP protocol complete: re-read authority and reconciled the original receipt without write replay. This is not model inference.' }, 'stop');
  })().catch(() => { if (!outgoing.headersSent) outgoing.writeHead(400, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ error: 'controlled_protocol_shape_rejected' })); }); });
}
function stream(outgoing: ServerResponse, delta: Record<string, unknown>, finishReason: string): void {
  outgoing.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  const id = `chatcmpl-controlled-${randomUUID()}`, base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'omp-controlled-protocol' };
  outgoing.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
  outgoing.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
  // Deliberately absent usage: the fixture has no tokenizer/billing and must not invent token counts.
  outgoing.end('data: [DONE]\n\n');
}
