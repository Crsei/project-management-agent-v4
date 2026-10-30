import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexSettings, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CodexAppServerClientFactory, layerAppServerClientFactory } from "../../../../../../../vendor/t3code/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts";
import { buildCodexInitializeParams, checkCodexProviderStatus, probeCodexSkillsForCwd, withCodexAppServerClient } from "../../../../../../../vendor/t3code/apps/server/src/provider/CodexProvider.ts";
import type { ProviderDriverContext } from "../../driver-adapter.ts";
import { makePmProviderAgentScopeLayer } from "../upstream-services/agent-scope.ts";
import { makePmProviderProcessPlatformLayer } from "../upstream-services/process-platform.ts";

const removed = ["ACCESS_TOKEN", "T3CODE_CODEX_LAUNCH_ARGS", "OPENAI_API_KEY", "OPENAI_BASE_URL"] as const;
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-complete-environment-"));
  const log = path.join(root, "child.jsonl");
  const executable = path.join(root, "codex-peer.mjs");
  await writeFile(executable, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ env: process.env, cwd: process.cwd() }) + '\\n');
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (id === undefined) continue;
  const result = method === 'initialize'
    ? { userAgent: 'codex/0.156.1', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'linux' }
    : method === 'account/read' ? { account: null, requiresOpenaiAuth: true }
    : method === 'skills/list' ? { data: [] } : {};
  console.log(JSON.stringify({ id, result }));
}
`, { mode: 0o700 });
  const context: ProviderDriverContext = {
    instanceId: "codex-env-regression", driver: "codex", revision: 1, config: {}, cwd: root,
    homeDirectory: path.join(root, "native-home"), stateDirectory: path.join(root, "private"),
    env: { HOME: root, PATH: path.dirname(process.execPath), RETAINED_NATIVE: "bound-native-value",
      ...Object.fromEntries(removed.map(name => [name, `controlled-${name}`])) },
  };
  const prepared = { ...context.env };
  for (const name of removed) delete prepared[name];
  const platform = makePmProviderProcessPlatformLayer(context);
  const settings = Schema.decodeUnknownSync(CodexSettings)({ binaryPath: executable, homePath: context.homeDirectory });
  return { context, prepared, settings, platform,
    children: async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { env: NodeJS.ProcessEnv; cwd: string }),
    close: () => rm(root, { recursive: true, force: true }) };
}
function assertPrepared(child: { env: NodeJS.ProcessEnv; cwd: string }, root: string) {
  for (const name of removed) assert.equal(child.env[name], undefined, `${name} must not be resurrected in the native child`);
  assert.equal(child.env.RETAINED_NATIVE, "bound-native-value");
  assert.equal(child.cwd, root);
}

test("complete prepared Codex Chat environment is authoritative at the actual client factory", async () => {
  const f = await fixture();
  try {
    const factory = layerAppServerClientFactory.pipe(Layer.provide(Layer.mergeAll(
      f.platform, makePmProviderAgentScopeLayer(f.context), Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
    )));
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const client = yield* (yield* CodexAppServerClientFactory).open({
        instanceId: ProviderInstanceId.make(f.context.instanceId), threadId: ThreadId.make("controlled-chat"),
        providerSessionId: ProviderSessionId.make("controlled-session"),
        runtimePolicy: { runtimeMode: "approval-required", interactionMode: "default", cwd: f.context.cwd },
        settings: f.settings, environment: f.prepared,
      });
      yield* client.request("initialize", buildCodexInitializeParams());
    }).pipe(Effect.provide(factory))));
    const children = await f.children();
    assert.equal(children.length, 1);
    assertPrepared(children[0]!, f.context.cwd);
  } finally { await f.close(); }
});

test("complete managed Codex status and skills environments are authoritative at the actual probe spawner", async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(checkCodexProviderStatus(f.settings, undefined, f.prepared,
      { status: "authenticated", type: "chatgpt" }).pipe(Effect.provide(f.platform)));
    await Effect.runPromise(Effect.scoped(probeCodexSkillsForCwd({ binaryPath: f.settings.binaryPath,
      homePath: f.settings.homePath, cwd: f.context.cwd, environment: f.prepared, extendEnv: false,
    }).pipe(Effect.provide(f.platform))));
    const children = await f.children();
    assert.equal(children.length, 2);
    for (const child of children) assertPrepared(child, f.context.cwd);
  } finally { await f.close(); }
});

test("genuine partial Codex probe environments still merge the PM-bound native environment", async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(Effect.scoped(withCodexAppServerClient({ binaryPath: f.settings.binaryPath,
      homePath: f.settings.homePath, cwd: f.context.cwd, environment: { PARTIAL_NATIVE: "partial-value" },
    }).pipe(Effect.provide(f.platform))));
    const [child] = await f.children();
    assert.ok(child);
    for (const name of removed) assert.equal(child.env[name], f.context.env[name]);
    assert.equal(child.env.RETAINED_NATIVE, "bound-native-value");
    assert.equal(child.env.PARTIAL_NATIVE, "partial-value");
  } finally { await f.close(); }
});
