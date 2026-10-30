import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as Effect from "effect/Effect";
import type { ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import { createProviderInstance, providerContext, updateProviderInstance } from "../../providers/instances.ts";
import { closeStore } from "../../durable/store.ts";
import { startPmProviderApplication, stopPmProviderApplication } from "../../providers/t3code/application.ts";
import { makePmProviderFamily } from "../../providers/t3code/registration.ts";
import { getPmProviderApplication } from "../../providers/t3code/application-access.ts";
import { codexDriver, makeCodexDriverLayer, codexProtocolResolver } from "../../providers/t3code/families/codex.ts";
import { makePmProviderRuntimeHost } from "../../providers/t3code/runtime-host.ts";
import { makePmResetCreditCoordinatorLayer } from "../../providers/t3code/upstream-services/reset-credit-coordinator.ts";
import { ResetCreditCoordinator } from "../../../../../../vendor/t3code/apps/server/src/provider/resetCreditCoordinator.ts";
import { consumeCoreResetCredit, probeCoreUsageLimits } from "./core.ts";

// A controlled app-server peer exercises the original client/schema/driver. It
// has no inference implementation and only reads disposable fixture state.
const script = `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
const args=process.argv.slice(2);
if(args.includes('--version')) { console.log('codex-cli 0.156.1'); process.exit(); }
if(args[0]!=='app-server') { console.log('[]'); process.exit(); }
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
for await(const line of readline.createInterface({input:process.stdin})) {
 const m=JSON.parse(line); fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(m)+'\\n');
 const report=JSON.parse(fs.readFileSync(process.env.FIXTURE_ACCOUNT,'utf8'));
 const reply=result=>send({id:m.id,result});
 const fail=()=>send({id:m.id,error:{code:-32000,message:'fixture-secret'}});
 if(m.method==='initialize') reply({userAgent:'codex/0.156.1',codexHome:process.env.CODEX_HOME,platformFamily:'unix',platformOs:'linux'});
 else if(m.method==='initialized') continue;
 else if(m.method==='account/read') reply({account:report.apiKey?{type:'apiKey'}:{type:'chatgpt',email:report.email,planType:'plus'},requiresOpenaiAuth:true});
 else if(m.method==='account/rateLimits/read') {
  if(report.failed) fail();
  else reply({accountId:report.id,rateLimits:{limitId:'codex',primary:{usedPercent:40,windowDurationMins:300}},rateLimitResetCredits:{availableCount:1}});
 } else if(m.method==='account/rateLimitResetCredit/consume') {
  const attempts=fs.existsSync(process.env.FIXTURE_RESETS)?fs.readFileSync(process.env.FIXTURE_RESETS,'utf8').trim().split('\\n').filter(Boolean):[];
  fs.appendFileSync(process.env.FIXTURE_RESETS,JSON.stringify(m.params)+'\\n');
  if(report.unknown && attempts.length===0) fail();
  // Original reset confirmation compares platform-clock checkedAt values across
  // separate native processes; an in-process fake clock cannot advance those.
  else {
   if(report.failAfterReset) fs.writeFileSync(process.env.FIXTURE_ACCOUNT,JSON.stringify({...report,failed:true}));
   await delay(2); reply({outcome:report.outcome||'reset'});
  }
 } else if(m.method==='config/read') fail();
 else if(m.method==='skills/list') reply({data:[]});
 else if(m.method==='model/list') reply({data:[],nextCursor:null});
 else if(m.id!==undefined) fail();
}
`;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-quota-"));
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
  const binary = path.join(root, "codex.mjs"), home = path.join(root, "home");
  const accountFile = path.join(root, "account-report.json"), log = path.join(root, "requests.jsonl"), resetLog = path.join(root, "resets.jsonl");
  await mkdir(home);
  await writeFile(binary, script); await chmod(binary, 0o700);
  const account = { id: "account-1", email: "codex@example.com" };
  await writeFile(accountFile, JSON.stringify(account));
  const instance = createProviderInstance({ instanceId: "source-codex-quota", driver: "codex", config: { binaryPath: binary, homePath: home },
    environment: Object.entries({ HOME: root, FIXTURE_ACCOUNT: accountFile, FIXTURE_LOG: log, FIXTURE_RESETS: resetLog })
      .map(([name, value]) => ({ name, value, sensitive: false })) });
  await startPmProviderApplication({ families: new Map([[codexDriver.driverKind, makePmProviderFamily(codexDriver, makeCodexDriverLayer)]]),
    protocols: new Map([["codex", codexProtocolResolver]]) });
  const rows = async (file: string): Promise<Array<{ method?: string; params?: Record<string, unknown>; idempotencyKey?: string }>> => {
    try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  return { instance, root, account,
    setAccount: (report: object) => writeFile(accountFile, JSON.stringify(report)),
    requests: () => rows(log), resets: () => rows(resetLog),
    close: async () => { await stopPmProviderApplication(); closeStore();
      if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
      await rm(root, { recursive: true, force: true }); },
  };
}

test("quota reads the retained original instance snapshot without starting a native thread or prompt", async () => {
  const f = await fixture();
  try {
    const result = await probeCoreUsageLimits(f.instance);
    assert.equal(result.unavailable, undefined);
    assert.equal(result.windows[0]?.usedPercent, 40);
    assert.equal(result.resetCredits?.availableCount, 1);
    assert.deepEqual(result.account, { id: f.account.id, email: f.account.email });
    assert.match(result.credentialFingerprint!, /^codex:[a-f0-9]{64}$/);
    const native = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const lease = yield* getPmProviderApplication().host.acquire(providerContext(f.instance), "status");
      return yield* lease.instance.snapshot.getSnapshot;
    })));
    assert.equal(result.checkedAt, native.usageLimits?.checkedAt);
    assert.deepEqual(result.windows, native.usageLimits?.windows);
    assert.ok((await f.requests()).every(request => !["thread/start", "turn/start", "account/login/start", "account/rateLimitResetCredit/consume"].includes(request.method ?? "")));
  } finally { await f.close(); }
});

test("reset rejects changed and disappeared displayed identity before sending a native credit request", async () => {
  const f = await fixture();
  try {
    const expected = await probeCoreUsageLimits(f.instance);
    assert.equal(expected.unavailable, undefined);
    await f.setAccount({ id: "account-2", email: "other@example.com" });
    await assert.rejects(consumeCoreResetCredit(f.instance, undefined, expected), /could not confirm/);
    assert.equal((await f.resets()).length, 0);
    await f.setAccount({ email: f.account.email });
    await assert.rejects(consumeCoreResetCredit(f.instance, undefined, expected), /could not confirm/);
    assert.equal((await f.resets()).length, 0);
    await f.setAccount({ ...f.account, apiKey: true });
    assert.equal((await probeCoreUsageLimits(f.instance)).unavailable?.reason, "unsupported");
    await assert.rejects(consumeCoreResetCredit(f.instance), /could not confirm/);
    assert.equal((await f.resets()).length, 0);
  } finally { await f.close(); }
});

test("unknown native reset retains the original coordinator key across a context revision and clears it only on confirmation", async () => {
  const f = await fixture();
  try {
    await f.setAccount({ ...f.account, unknown: true });
    const expected = await probeCoreUsageLimits(f.instance);
    assert.equal(expected.unavailable, undefined);
    await assert.rejects(consumeCoreResetCredit(f.instance, undefined, expected), /could not confirm/);
    const updated = updateProviderInstance(f.instance.instanceId, { label: "Retained login, new context" });
    assert.deepEqual(await consumeCoreResetCredit(updated, undefined, expected), { outcome: "reset" });
    let attempts = await f.resets();
    assert.equal(attempts.length, 2);
    assert.match(attempts[0]!.idempotencyKey!, /^[a-f0-9-]{36}$/);
    assert.equal(attempts[0]!.idempotencyKey, attempts[1]!.idempotencyKey);
    assert.deepEqual(await consumeCoreResetCredit(updated), { outcome: "reset" });
    attempts = await f.resets();
    assert.notEqual(attempts[1]!.idempotencyKey, attempts[2]!.idempotencyKey);
  } finally { await f.close(); }
});

test("stale revisions and aborted quota operations cannot dispatch a reset or publish a successful empty snapshot", async () => {
  const f = await fixture();
  try {
    const updated = updateProviderInstance(f.instance.instanceId, { label: "Changed" });
    assert.equal((await probeCoreUsageLimits(f.instance)).unavailable?.reason, "probeFailed");
    await assert.rejects(consumeCoreResetCredit(f.instance), /could not confirm/);
    const abort = new AbortController(); abort.abort();
    assert.equal((await probeCoreUsageLimits(updated, abort.signal)).unavailable?.reason, "probeFailed");
    await assert.rejects(consumeCoreResetCredit(updated, abort.signal), /could not confirm/);
    assert.equal((await f.resets()).length, 0);
  } finally { await f.close(); }
});

test("failed native probes visibly retain last-good quota, reject spending, and recover only after a successful probe", async () => {
  const f = await fixture();
  try {
    await f.setAccount({ ...f.account, failed: true });
    const missing = await probeCoreUsageLimits(f.instance);
    assert.equal(missing.unavailable?.reason, "probeFailed");
    assert.deepEqual(missing.windows, []);
    assert.ok(!JSON.stringify(missing).includes("fixture-secret"));
    await f.setAccount(f.account);
    const known = await probeCoreUsageLimits(f.instance);
    assert.equal(known.unavailable, undefined); assert.equal(known.windows[0]?.usedPercent, 40);
    await f.setAccount({ ...f.account, failed: true });
    const retained = await probeCoreUsageLimits(f.instance);
    assert.equal(retained.checkedAt, known.checkedAt);
    assert.equal(retained.unavailable?.reason, "probeFailed");
    assert.ok(Date.parse(retained.lastProbeAt!) >= Date.parse(known.checkedAt));
    assert.deepEqual(retained.windows, known.windows);
    assert.equal(retained.account?.id, known.account?.id);
    assert.ok(!JSON.stringify(retained).includes("fixture-secret"));
    await assert.rejects(consumeCoreResetCredit(f.instance, undefined, known), /could not confirm/);
    assert.equal((await f.resets()).length, 0);
    await f.setAccount(f.account);
    const recovered = await probeCoreUsageLimits(f.instance);
    assert.equal(recovered.unavailable, undefined);
    assert.deepEqual(recovered.windows, known.windows);
    assert.deepEqual(await consumeCoreResetCredit(f.instance, undefined, recovered), { outcome: "reset" });
    assert.equal((await f.resets()).length, 1);
  } finally { await f.close(); }
});

test("a source-acknowledged reset with an unconfirmed replacement snapshot is not returned as success", async () => {
  const f = await fixture();
  try {
    await f.setAccount({ ...f.account, failAfterReset: true });
    const expected = await probeCoreUsageLimits(f.instance);
    assert.equal(expected.unavailable, undefined);
    await assert.rejects(consumeCoreResetCredit(f.instance, undefined, expected), /reset was applied.*could not confirm/s);
    assert.equal((await f.resets()).length, 1);
  } finally { await f.close(); }
});

test("real reset coordinators share pending keys within one runtime host, never between applications", async () => {
  const first = makePmProviderRuntimeHost(), second = makePmProviderRuntimeHost();
  const get = (host: ProviderRuntimeHostService) => Effect.runPromise(
    ResetCreditCoordinator.pipe(Effect.provide(makePmResetCreditCoordinatorLayer(host))));
  const a = await get(first), retained = await get(first), b = await get(second);
  assert.equal(a, retained); assert.notEqual(a, b);
  const seen: string[] = [];
  const unknown = (key: string) => { seen.push(key); return Effect.fail(new Error("Unknown outcome")); };
  await assert.rejects(Effect.runPromise(a.redeem("same-login", unknown)));
  await assert.rejects(Effect.runPromise(retained.redeem("same-login", unknown)));
  await assert.rejects(Effect.runPromise(b.redeem("same-login", unknown)));
  assert.equal(seen[0], seen[1]); assert.notEqual(seen[0], seen[2]);
});
