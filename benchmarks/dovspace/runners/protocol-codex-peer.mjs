#!/usr/bin/env node
// Explicit protocol-calibration ONLY. No inference, gold answers, replayed PM state or paid-model success.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const home = process.env.CODEX_HOME || process.env.HOME || '/provider-home';
if (args.includes('--version')) {
  console.log('codex-cli 0.167.0');
} else if (args[0] === 'app-server') {
  const threads = new Map();
  let active;
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  const notify = (method, params) => send({ method, params });
  const now = () => Math.floor(Date.now() / 1000);
  function finish(turn, status, text) {
    if (turn.finished) return;
    turn.finished = true;
    const item = { id: `${turn.id}:answer`, type: 'agentMessage', phase: 'final_answer', text };
    const result = { id: turn.id, status, items: text ? [item] : [], error: status === 'failed' ? { message: text, codexErrorInfo: 'other', additionalDetails: null } : null, startedAt: turn.startedAt, completedAt: now() };
    threads.get(turn.threadId)?.turns.push(result);
    if (text) notify('item/completed', { threadId: turn.threadId, turnId: turn.id, item, completedAtMs: Date.now() });
    notify('turn/completed', { threadId: turn.threadId, turn: result });
  }
  async function perform(turn, params) {
    const text = (params.input || []).map(item => item.text || '').join('\n');
    const bridge = text.match(/agent-tools\.mjs'\s+'(http:\/\/127\.0\.0\.1:\d+)'/)?.[1];
    if (!bridge) throw new Error('Real generation-scoped PM bridge was not provided.');
    const manifest = JSON.parse(fs.readFileSync('/workspace/pm-targets.json', 'utf8'));
    const target = manifest.targets['beacon-receipt'];
    const scope = { workspaceId: manifest.workspaceId, projectId: target.projectId };
    async function call(name, argumentsValue, operationId = randomUUID()) {
      const response = await fetch(`${bridge}/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, name, target: scope, arguments: argumentsValue }), signal: turn.controller.signal });
      if (!response.ok) throw new Error(`Real PM bridge rejected ${name} (${response.status}).`);
      return await response.json();
    }
    const handoffPath = '/workspace/artifacts/handoff.json';
    fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
    if (text.includes('PROTOCOL_CALIBRATION_RESUME')) {
      // The requester Session/generation is bound by the trusted host, never supplied by this peer.
      await delay(100, undefined, { signal: turn.controller.signal });
      const handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
      const response = await fetch(`http://127.0.0.1:3901/bench/receipts/${handoff.operationId}`, { signal: turn.controller.signal });
      if (!response.ok) throw new Error(`Original receipt lookup rejected (${response.status}).`);
      const recovered = await response.json();
      if (recovered.operationId !== handoff.operationId || recovered.status !== 'succeeded' || recovered.result?.receipt?.targetId !== target.entityId) throw new Error('Real original receipt authority did not match.');
      handoff.receipt = recovered.result.receipt;
      handoff.revision = recovered.result.receipt.revision || recovered.result.items?.[0]?.revision;
      handoff.protocolRecovery = { kind: 'protocol-calibration', originalOperationId: recovered.operationId, status: recovered.status };
      fs.writeFileSync(handoffPath, JSON.stringify(handoff, null, 2));
      finish(turn, 'completed', 'Controlled native protocol peer recovered the original real PM receipt. No model efficacy was evaluated.');
      return;
    }
    const read = await call('pm_read', { id: target.entityId, bodyOffset: 0, bodyLimit: 12000 });
    const item = read.result?.items?.[0];
    if (read.status !== 'succeeded' || item?.id !== target.entityId || typeof item.revision !== 'string') throw new Error('Real target read did not return current revision.');
    const operationId = randomUUID();
    fs.writeFileSync(handoffPath, JSON.stringify({ workspaceId: manifest.workspaceId, projectId: target.projectId, targetId: target.entityId, revision: item.revision, operationId, remainingWork: ['Query this original identity after the scheduled interruption.'], kind: 'protocol-calibration' }, null, 2));
    try {
      const outcome = await call('pm_update_task', { id: target.entityId, revision: item.revision, title: null, description: null, assigneeId: null, priority: 'high', startDate: null, dueDate: null, labels: null }, operationId);
      if (outcome.status !== 'unknown') { finish(turn, 'failed', `Expected a real unknown response-loss outcome, received ${outcome.status}.`); return; }
      fs.writeFileSync('/workspace/artifacts/protocol-unknown.json', JSON.stringify({ kind: 'protocol-calibration', operationId, outcome: outcome.status }));
    } catch (error) {
      if (turn.controller.signal.aborted) return;
      // Unknown acceptance is deliberately retained; there is NO automatic second write.
      fs.writeFileSync('/workspace/artifacts/protocol-unknown.json', JSON.stringify({ kind: 'protocol-calibration', operationId, outcome: 'unknown', message: String(error?.message || error) }));
      // Keep the real turn active until the trusted runner sends turn/interrupt.
    }
  }
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const message = JSON.parse(line), params = message.params || {};
    fs.mkdirSync('/workspace/artifacts', { recursive: true });
    fs.appendFileSync('/workspace/artifacts/protocol-rpc.jsonl', JSON.stringify({ method: message.method, threadId: params.threadId ?? null }) + '\n');
    if (!message.method) continue;
    const respond = result => send({ id: message.id, result });
    const reject = error => send({ id: message.id, error: { code: -32000, message: error } });
    switch (message.method) {
      case 'initialize': respond({ userAgent: 'codex/0.167.0 protocol-calibration', codexHome: home, platformFamily: 'unix', platformOs: 'linux' }); break;
      case 'initialized': break;
      case 'account/read': respond({ account: { type: 'apiKey' }, requiresOpenaiAuth: false }); break;
      case 'account/rateLimits/read': reject('No account or inference usage exists in protocol calibration.'); break;
      case 'config/read': reject('No native config overrides in controlled protocol calibration.'); break;
      case 'skills/list': respond({ data: [] }); break;
      case 'model/list': respond({ nextCursor: null, data: [{ id: 'protocol-calibration', model: 'protocol-calibration', displayName: 'Controlled protocol peer (NO inference)', description: 'Only protocol calibration, never model efficacy.', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Protocol only' }], serviceTiers: [], defaultServiceTier: null }] }); break;
      case 'thread/start': {
        const id = randomUUID();
        const thread = { id, sessionId: id, cliVersion: '0.167.0', createdAt: now(), updatedAt: now(), cwd: params.cwd || '/workspace', ephemeral: false, forkedFromId: null, model: params.model, modelProvider: 'bench', preview: '', projectId: null, source: 'cli', status: { type: 'idle' }, turns: [] };
        threads.set(thread.id, thread);
        respond({ thread, model: params.model, modelProvider: 'bench', cwd: thread.cwd, runtimeWorkspaceRoots: [thread.cwd], instructionSources: [], approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: { type: 'readOnly' }, reasoningEffort: 'medium', serviceTier: null });
        break;
      }
      case 'thread/read': if (threads.has(params.threadId)) respond({ thread: threads.get(params.threadId) }); else reject('Unknown controlled thread.'); break;
      case 'thread/loaded/list': respond({ data: [...threads.keys()], nextCursor: null }); break;
      case 'thread/turns/list': respond({ data: threads.get(params.threadId)?.turns || [], nextCursor: null }); break;
      case 'turn/start': {
        if (!threads.has(params.threadId)) { reject('Unknown controlled thread.'); break; }
        active = { id: randomUUID(), threadId: params.threadId, startedAt: now(), controller: new AbortController(), finished: false };
        const view = { id: active.id, items: [], status: 'inProgress', error: null, startedAt: active.startedAt, completedAt: null };
        respond({ turn: view }); notify('turn/started', { threadId: active.threadId, turn: view });
        const turn = active;
        void perform(turn, params).catch(error => { if (!turn.controller.signal.aborted) { fs.mkdirSync('/workspace/artifacts', { recursive: true }); fs.writeFileSync('/workspace/artifacts/protocol-error.json', JSON.stringify({ kind: 'protocol-calibration', message: String(error?.message || error) })); finish(turn, 'failed', String(error?.message || error)); } });
        break;
      }
      case 'turn/interrupt': respond({}); if (active) { active.controller.abort(); finish(active, 'interrupted', ''); } break;
      case 'thread/backgroundTerminals/list': respond({ data: [], nextCursor: null }); break;
      case 'thread/unsubscribe': respond({ status: 'unsubscribed' }); break;
      default: if (message.id !== undefined) reject(`Unsupported controlled protocol method: ${message.method}`);
    }
  }
} else {
  console.error('This executable is an explicitly controlled native protocol calibration peer, not a model.');
  process.exitCode = 2;
}
