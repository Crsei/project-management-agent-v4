import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { closeStore } from "../../durable/store.ts";
import { createProviderInstance, updateProviderInstance, type StoredProviderInstance } from "../../providers/instances.ts";
import { startPmProviderApplication, stopPmProviderApplication } from "../../providers/t3code/application.ts";
import { makePmProviderFamily } from "../../providers/t3code/registration.ts";
import { claudeDriver, claudeProtocolResolver, makeClaudeDriverLayer } from "../../providers/t3code/families/claude.ts";
import { consumeCoreResetCredit, probeCoreUsageLimits } from "./core.ts";

const script = `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
if(process.argv.includes('--version')) { console.log('2.1.300 (Claude Code)'); process.exit(); }
readline.createInterface({input:process.stdin}).on('line',line=>{
 const event=JSON.parse(line);
 fs.appendFileSync(process.env.QUOTA_LOG,JSON.stringify(event)+'\\n');
 if(event.type!=='control_request') return;
 let response={};
 if(event.request.subtype==='initialize') response={commands:[],agents:[],models:[],output_style:'default',available_output_styles:['default'],account:{email:'claude@example.com',subscriptionType:'pro',tokenSource:'oauth',apiKeySource:'none',apiProvider:'firstParty'}};
 if(event.request.subtype==='get_usage') response={session:{},rate_limits_available:true,rate_limits:{five_hour:{utilization:51,resets_at:null}}};
 process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:event.request_id,response}})+'\\n');
});
`;
const credits = { cedar_ember: { eligible: true, next_grant_id: "grant", grants: [{ id: "grant", resets_left: 1, usable_now: true }] } };

async function withClaude(consume: (fixture: { instance: StoredProviderInstance; home: string; log: string; setAccountFetch: (handler: (request: Request) => Promise<Response>) => void }) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-quota-claude-"));
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
  const unexpectedRequests: string[] = [];
  let accountFetch: ((request: Request) => Promise<Response>) | undefined;
  const setAccountFetch = (handler: (request: Request) => Promise<Response>) => { accountFetch = handler; };
  const fixtureFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      // The original status chain also checks the model manifest and package version.
      // These are read-only metadata requests, not quota reads or redemptions.
      const metadata = request.method === "GET" && !url.search && (
        url.origin === "https://raw.githubusercontent.com" && url.pathname === "/pingdotgg/t3code/main/apps/server/src/provider/model-manifest.json"
        || url.origin === "https://registry.npmjs.org" && decodeURIComponent(url.pathname) === "/@anthropic-ai/claude-code/latest");
      if (metadata) return new Response(null, { status: 503 });
      const accountRead = request.method === "GET" && url.origin === "https://api.anthropic.com" && url.pathname === "/api/oauth/usage";
      const redemption = request.method === "POST" && url.origin === "https://api.anthropic.com" && url.pathname === "/api/organizations/org/reset_rate_limits";
      if (!accountRead && !redemption) {
        unexpectedRequests.push(`${request.method} ${url.href}`);
        throw new Error("Unexpected original Provider request.");
      }
      if (!accountFetch) throw new Error("The fixture account handler has not been configured.");
      return accountFetch(request);
  };
  try {
    const cli = path.join(root, "claude.mjs"), home = path.join(root, "home"), log = path.join(root, "sdk.jsonl");
    await mkdir(home);
    await writeFile(cli, script); await chmod(cli, 0o700);
    const instance = createProviderInstance({ driver: "claude", label: "Fixture", config: { binaryPath: cli, homePath: home },
      environment: Object.entries({ HOME: root, QUOTA_LOG: log, ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_BASE_URL: "", CLAUDE_CODE_USE_BEDROCK: "", CLAUDE_CODE_USE_VERTEX: "",
        CLAUDE_CODE_USE_FOUNDRY: "", ANTHROPIC_CUSTOM_HEADERS: "" }).map(([name, value]) => ({ name, value, sensitive: false })) });
    // Disposable credentials exercise the source reader, never a real account.
    await writeFile(path.join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token" } }));
    await writeFile(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: "org" } }));
    await startPmProviderApplication({ families: new Map([[claudeDriver.driverKind, makePmProviderFamily(claudeDriver,
      (context, runtimeHost) => makeClaudeDriverLayer(context, runtimeHost).pipe(
        Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fixtureFetch)),
      ))]]), protocols: new Map([["claude", claudeProtocolResolver]]) });
    await consume({ instance, home, log, setAccountFetch });
  } finally {
    await stopPmProviderApplication(); closeStore();
    if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(unexpectedRequests, []);
  }
}

test("Claude original quota probe rejects a revision changed after its real credits read, before any redemption", { skip: process.platform === "darwin" }, async () => withClaude(async f => {
  let reads = 0, redemptions = 0;
  f.setAccountFetch(async request => {
    if (request.method === "POST") { redemptions++; throw new Error("Unexpected redemption after revision change"); }
    reads++;
    if (reads === 1) updateProviderInstance(f.instance.instanceId, { label: "Changed during native credit read" });
    return Response.json(credits);
  });
  await assert.rejects(consumeCoreResetCredit(f.instance), /could not confirm/);
  // The source owns both its initial background probe and explicit refresh.
  assert.ok(reads >= 1); assert.equal(redemptions, 0);
  const requests = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(requests.some(request => request.request?.subtype === "get_usage"));
  assert.ok(requests.every(request => request.type !== "user"));
}));

test("Claude unknown credit outcome keeps the source request ID across revisions and confirms only a native outcome", { skip: process.platform === "darwin" }, async () => withClaude(async f => {
  const attempts: Array<{ request_id: string; grant_id: string }> = [];
  f.setAccountFetch(async request => {
    if (request.method === "GET") return Response.json(credits);
    const body = await request.json();
    attempts.push(body);
    return Response.json({ result: attempts.length === 1 ? "unavailable" : "reset" });
  });
  const expected = await probeCoreUsageLimits(f.instance);
  assert.equal(expected.unavailable, undefined);
  assert.equal(expected.windows[0]?.usedPercent, 51);
  assert.equal(expected.resetCredits?.nextCreditId, "grant");
  assert.deepEqual(expected.account, { email: "claude@example.com", workspaceId: "org" });
  const cached = await probeCoreUsageLimits(f.instance);
  assert.equal(cached.unavailable, undefined);
  assert.equal(cached.checkedAt, expected.checkedAt);
  assert.deepEqual(cached.windows, expected.windows);
  const cachedRequests = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(cachedRequests.filter(request => request.request?.subtype === "get_usage").length, 1);
  await assert.rejects(consumeCoreResetCredit(f.instance, undefined, expected), /could not confirm/);
  assert.equal(attempts.length, 1);
  const updated = updateProviderInstance(f.instance.instanceId, { label: "Same login, retained application" });
  assert.deepEqual(await consumeCoreResetCredit(updated, undefined, expected), { outcome: "reset" });
  assert.equal(attempts.length, 2);
  assert.match(attempts[0]!.request_id, /^[a-f0-9-]{36}$/);
  assert.equal(attempts[0]!.request_id, attempts[1]!.request_id);
  assert.equal(attempts[0]!.grant_id, "grant");
  const requests = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(requests.every(request => request.type !== "user"));
}));

test("Claude changed displayed workspace cannot spend a credit through a retained source context", { skip: process.platform === "darwin" }, async () => withClaude(async f => {
  let redemptions = 0;
  f.setAccountFetch(async request => {
    if (request.method === "GET") return Response.json(credits);
    redemptions++; return Response.json({ result: "reset" });
  });
  const expected = await probeCoreUsageLimits(f.instance);
  assert.equal(expected.account?.workspaceId, "org");
  await writeFile(path.join(f.home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: "different-org" } }));
  await assert.rejects(consumeCoreResetCredit(f.instance, undefined, expected), /could not confirm/);
  assert.equal(redemptions, 0);
}));
