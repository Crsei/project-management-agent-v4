// Protocol fixtures adapted from t3code; Copyright (c) 2026 T3 Tools Inc. MIT.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProviderInstance, updateProviderInstance } from "../../providers/instances.ts";
import { claudeCreditsFromResponse, claudeLimitsFromResponse, codexLimitsFromResponse, consumeCoreResetCredit, grokLimitsFromResponse, probeCoreUsageLimits } from "./core.ts";

const checkedAt = "2026-09-22T12:00:00.000Z";
test("Codex native snapshot chooses the main allowance and maps duration, reset and credits", () => {
  const result = codexLimitsFromResponse({ rateLimits: { limitId: "spark", primary: { usedPercent: 80 } }, rateLimitsByLimitId: { codex: { planType: "free", primary: { usedPercent: 110, resetsAt: 1800000000 }, individualLimit: { remainingPercent: 35 } } }, rateLimitResetCredits: { availableCount: 2, credits: [{ status: "available", expiresAt: 1800000001 }, { status: "used", expiresAt: 1 }] } }, checkedAt);
  assert.equal(result.windows[0]?.kind, "monthly"); assert.equal(result.windows[0]?.usedPercent, 100); assert.equal(result.windows[0]?.resetsAt, new Date(1800000000 * 1000).toISOString());
  assert.equal(result.windows[1]?.usedPercent, 65); assert.equal(result.resetCredits?.availableCount, 2); assert.equal(result.resetCredits?.nextExpiresAt, new Date(1800000001 * 1000).toISOString());
  assert.deepEqual(codexLimitsFromResponse({ rateLimits: { limitId: "spark", primary: { usedPercent: 1 } } }, checkedAt).windows, []);
});
test("Claude SDK usage and credit grants retain actual percent, scoped windows and live grant semantics", () => {
  const result = claudeLimitsFromResponse({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 72, resets_at: "2026-09-22T15:00:00Z" }, model_scoped: [{ display_name: "Sonnet 4.5", utilization: 10 }], spend: { enabled: true, used: { amount_minor: 9, currency: "USD", exponent: 2 }, limit: { amount_minor: 30, currency: "USD", exponent: 2 } } } }, checkedAt);
  assert.deepEqual(result.windows.map(w => [w.id, w.usedPercent]), [["five_hour", 72], ["seven_day_sonnet_4_5", 10], ["monthly_spend", 30]]);
  assert.equal(result.windows[0]?.resetsAt, "2026-09-22T15:00:00.000Z");
  assert.equal(claudeLimitsFromResponse({ rate_limits_available: false }, checkedAt).unavailable?.reason, "unsupported");
  assert.equal(claudeLimitsFromResponse({ rate_limits_available: true, rate_limits: null }, checkedAt).unavailable?.reason, "probeFailed");
  const grants = { eligible: true, next_grant_id: "a", grants: [{ id: "a", usable_now: true, resets_left: 2, ends_at: "2026-10-01T00:00:00Z" }, { id: "b", usable_now: true, resets_left: 3 }, { id: "c", paused: true, usable_now: true, resets_left: 9 }, { id: "d", usable_now: true, resets_left: 3, ends_at: "2026-99-40T00:00:00Z" }] };
  assert.deepEqual(claudeCreditsFromResponse(grants, Date.parse(checkedAt)), { availableCount: 5, nextCreditId: "a", nextExpiresAt: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual(claudeCreditsFromResponse({ ...grants, next_grant_id: "c" }, Date.parse(checkedAt)), { availableCount: 0 });
});
test("Grok only infers zero with a valid complete subscription period", () => {
  assert.equal(grokLimitsFromResponse({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-01T00:00:00Z", end: "2026-09-08T00:00:00Z" } } }, checkedAt).windows[0]?.usedPercent, 0);
  assert.deepEqual(grokLimitsFromResponse({ config: { currentPeriod: { type: "WEEKLY", start: "2026-02-30T00:00:00Z", end: "2026-03-08T00:00:00Z" } } }, checkedAt).windows, []);
  assert.equal(grokLimitsFromResponse({ config: { creditUsagePercent: 120, currentPeriod: { type: "MONTHLY" } } }, checkedAt).windows[0]?.usedPercent, 100);
});

async function isolated(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-core-")); const previous = process.env.AGENT_WORKSPACE_DATA_DIR; const originalFetch = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  try { await fn(root); } finally { globalThis.fetch = originalFetch; if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous; await rm(root, { recursive: true, force: true }); }
}
const fixtureScript = `#!/usr/bin/env node
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('claude 2.1.219'); process.exit(); }
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); let result;
 if (m.method === 'initialize') result={userAgent:'codex/1.0.0'};
 if (m.method === 'account/read') result={account:{type:process.env.FIXTURE_API_KEY ? 'apiKey' : 'chatgpt',email:'codex@example.com',planType:'plus'},requiresOpenaiAuth:true};
 if (m.method === 'account/rateLimits/read' && process.env.FIXTURE_FAIL) { console.log(JSON.stringify({id:m.id,error:{code:-1,message:'fixture-secret'}})); return; }
 if (m.method === 'account/rateLimits/read') result={accountId:'account-1',rateLimits:{primary:{usedPercent:40,windowDurationMins:300}},rateLimitResetCredits:{availableCount:1}};
 if (m.method === 'account/rateLimitResetCredit/consume') { appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(m.params)+'\\n'); result={outcome:'reset'}; }
 if (result) console.log(JSON.stringify({id:m.id,result}));
 if(m.type !== 'control_request') return;
 let response;
 if(m.request.subtype === 'initialize') response={commands:[],agents:[],models:[],output_style:'default',available_output_styles:['default'],account:{email:'claude@example.com',subscriptionType:'pro',tokenSource:'oauth',apiProvider:'firstParty'}};
 if(m.request.subtype === 'get_usage' && process.env.FIXTURE_FAIL) { console.log(JSON.stringify({type:'control_response',response:{subtype:'error',request_id:m.request_id,error:'fixture-secret'}})); return; }
 if(m.request.subtype === 'get_usage') response={session:{},rate_limits_available:true,rate_limits:{five_hour:{utilization:51,resets_at:null}}};
 if(response) console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response}}));
});
`;
async function fakeCli(root: string): Promise<string> { const file = path.join(root, "fixture.mjs"); await writeFile(file, fixtureScript); await chmod(file, 0o755); return file; }

test("Grok uses only selected home, refuses alternate configuration and sanitizes failed HTTP", async () => isolated(async () => {
  const instance = createProviderInstance({ instanceId: "grok-probe", driver: "grok", label: "Grok" });
  await writeFile(path.join(instance.homeDirectory, "auth.json"), JSON.stringify({ "https://accounts.x.ai/sign-in": { key: "fixture-secret", email: "TEST@example.com" } }));
  globalThis.fetch = async (input, init) => { assert.equal(String(input), "https://cli-chat-proxy.grok.com/v1/billing?format=credits"); assert.equal(init?.redirect, "error"); assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-secret"); return Response.json({ config: { creditUsagePercent: 12, currentPeriod: { type: "MONTHLY", end: "2026-12-01T00:00:00Z" } } }); };
  const result = await probeCoreUsageLimits(instance); assert.equal(result.windows[0]?.usedPercent, 12); assert.match(result.credentialFingerprint!, /^grok:[a-f0-9]{64}$/); assert.ok(!JSON.stringify(result).includes("fixture-secret"));
  assert.deepEqual(result.account, { email: "TEST@example.com" });
  globalThis.fetch = async () => { throw new Error("fixture-secret"); }; const failure = await probeCoreUsageLimits(instance); assert.equal(failure.unavailable?.reason, "probeFailed"); assert.ok(!JSON.stringify(failure).includes("fixture-secret"));
  const apiKey = updateProviderInstance(instance.instanceId, { env: { XAI_API_KEY: "fixture-key" } }); assert.equal((await probeCoreUsageLimits(apiKey)).unavailable?.reason, "unsupported");
  assert.equal((await probeCoreUsageLimits(instance)).unavailable?.reason, "probeFailed");
}));

test("Codex app-server probe and explicit reset use the real JSON-RPC methods", async () => isolated(async root => {
  const cli = await fakeCli(root); const log = path.join(root, "requests");
  const instance = createProviderInstance({ instanceId: "codex-fixture", driver: "codex", label: "Codex", config: { binaryPath: cli }, env: { FIXTURE_LOG: log } });
  const limits = await probeCoreUsageLimits(instance); assert.equal(limits.windows[0]?.usedPercent, 40); assert.equal(limits.resetCredits?.availableCount, 1); assert.match(limits.credentialFingerprint!, /^codex:[a-f0-9]{64}$/);
  assert.deepEqual(limits.account, { id: "account-1", email: "codex@example.com", plan: "plus" });
  assert.deepEqual(await consumeCoreResetCredit(instance), { outcome: "reset" }); const request = JSON.parse((await readFile(log, "utf8")).trim()); assert.match(request.idempotencyKey, /^[a-f0-9-]{36}$/);
  const apiKey = updateProviderInstance(instance.instanceId, { env: { FIXTURE_API_KEY: "1" } });
  assert.equal((await probeCoreUsageLimits(apiKey)).unavailable?.reason, "unsupported");
  const broken = updateProviderInstance(instance.instanceId, { env: { FIXTURE_API_KEY: null, FIXTURE_FAIL: "1" } });
  const failed = await probeCoreUsageLimits(broken); assert.equal(failed.unavailable?.reason, "probeFailed"); assert.ok(!JSON.stringify(failed).includes("fixture-secret"));
}));

test("Claude SDK probe and reset send bounded first-party requests with one idempotency key on unknown outcome", async () => isolated(async root => {
  if (process.platform === "darwin") return;
  const cli = await fakeCli(root); const instance = createProviderInstance({ instanceId: "claude-fixture", driver: "claude", label: "Claude", config: { binaryPath: cli } });
  await writeFile(path.join(instance.homeDirectory, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-oauth" } }));
  await writeFile(path.join(instance.homeDirectory, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: "org-test" } }));
  const attempts: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => { const url = String(input); assert.equal(init?.redirect, "error"); assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-oauth");
    if (url === "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1") return Response.json({ cedar_ember: { eligible: true, next_grant_id: "grant_a", grants: [{ id: "grant_a", usable_now: true, resets_left: 1 }] } });
    assert.equal(url, "https://api.anthropic.com/api/organizations/org-test/reset_rate_limits"); const body = JSON.parse(String(init?.body)); attempts.push(body); return Response.json({ result: attempts.length === 1 ? "unavailable" : "reset" }); };
  const limits = await probeCoreUsageLimits(instance); assert.equal(limits.windows[0]?.usedPercent, 51); assert.equal(limits.resetCredits?.nextCreditId, "grant_a");
  assert.deepEqual(limits.account, { email: "claude@example.com", plan: "pro", workspaceId: "org-test" });
  await assert.rejects(consumeCoreResetCredit(instance), /could not confirm/); assert.equal(attempts.length, 1); assert.deepEqual(await consumeCoreResetCredit(instance), { outcome: "reset" });
  assert.equal(attempts[0]?.request_id, attempts[1]?.request_id); assert.equal(attempts[0]?.grant_id, "grant_a");
  const broken = updateProviderInstance(instance.instanceId, { env: { FIXTURE_FAIL: "1" } });
  const failed = await probeCoreUsageLimits(broken); assert.equal(failed.unavailable?.reason, "probeFailed"); assert.ok(!JSON.stringify(failed).includes("fixture-secret"));
  const external = updateProviderInstance(instance.instanceId, { env: { ANTHROPIC_API_KEY: "fixture-key" } });
  assert.equal((await probeCoreUsageLimits(external)).unavailable?.reason, "unsupported");
}));
