import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { getStoredInstance, providerContext, updateProviderInstance, updateProviderSettings, getProviderSettings, subscribeProviderSettingsChanges } from "../instances.ts";
import { makePmProviderHostServices, makePmServerConfigLayer, makePmServerSettings } from "./host.ts";
import { makePmProviderRuntimeHost, pmRuntimeBinding } from "./runtime-host.ts";
import { providerAttachmentsDirectory, registerProviderAttachment, resolveAttachmentPath, resolveAttachmentPathById } from "./upstream-services/attachments.ts";
import { ProviderInstanceId, ThreadId, type ChatAttachment } from "@t3tools/contracts";
import { ServerConfig } from "./upstream-services/server-config.ts";

async function isolated(use: () => Promise<void>) {
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR;
  const directory = await mkdtemp(path.join(os.tmpdir(), "pm-provider-host-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  try { await use(); }
  finally { if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous; await rm(directory, { recursive: true, force: true }); }
}

test("settings snapshot excludes every synchronous writer and releases after failure", async () => isolated(async () => {
  const current = getStoredInstance("codex")!;
  const settings = makePmServerSettings();
  await assert.rejects(Effect.runPromise(settings.withSettingsSnapshot(snapshot => Effect.gen(function* () {
    assert.ok(snapshot.providerInstances[ProviderInstanceId.make("codex")]);
    assert.throws(() => updateProviderInstance("codex", { label: "must not commit" }, current.revision), /settings are in use/);
    assert.throws(() => updateProviderSettings(getProviderSettings().revision, 0), /settings are in use/);
    yield* Effect.fail(new Error("release on failure"));
  }))), /release on failure/);
  assert.equal(getStoredInstance("codex")!.revision, current.revision);
  assert.equal(updateProviderInstance("codex", { label: "committed" }, current.revision).label, "committed");
}));

test("scoped subscription retains a change published before the stream starts", async () => isolated(async () => {
  getStoredInstance("codex");
  const settings = makePmServerSettings();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const changes = yield* settings.subscribeChanges;
    const current = getStoredInstance("codex")!;
    updateProviderInstance("codex", { label: "buffered-before-consume" }, current.revision);
    const next = yield* Stream.runHead(changes);
    assert.equal(next._tag, "Some");
    if (next._tag === "Some") assert.equal(next.value.providerInstances[ProviderInstanceId.make("codex")]?.displayName, "buffered-before-consume");
  })));
}));

test("a new instance can launch its first native status process from the private state directory", async () => isolated(async () => {
  const context = providerContext(updateProviderInstance("claude", { enabled: true }), process.cwd());
  const launched = await Effect.runPromise(Effect.gen(function* () {
    const config = yield* ServerConfig;
    const child = yield* Effect.tryPromise(() => promisify(execFile)(process.execPath,
      ["-e", "process.stdout.write(process.cwd())"], { cwd: config.stateDir, env: {} }));
    return { actual: child.stdout, expected: config.stateDir };
  }).pipe(Effect.provide(makePmServerConfigLayer(context))));
  assert.equal(launched.actual, launched.expected);
}));

test("host paths and environment retain native HOME and reject unknown or escaping attachments", async () => isolated(async () => {
  const context = providerContext(updateProviderInstance("codex", { enabled: true }), process.cwd());
  const before = { HOME: context.env.HOME, XDG_CONFIG_HOME: context.env.XDG_CONFIG_HOME };
  const services = makePmProviderHostServices(context, makePmProviderRuntimeHost());
  const root = providerAttachmentsDirectory();
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "valid.txt"), "safe");
  const attachment: ChatAttachment = { id: "known", type: "file", name: "valid.txt", mimeType: "text/plain", sizeBytes: 4 };
  assert.equal(services.resolveAttachmentPath(attachment), null);
  registerProviderAttachment(attachment, "valid.txt");
  assert.equal(services.resolveAttachmentPath(attachment), path.join(root, "valid.txt"));
  assert.equal(services.resolveAttachmentPath({ ...attachment, id: "../known" }), null);
  await symlink(os.tmpdir(), path.join(root, "outside"));
  assert.throws(() => registerProviderAttachment(attachment, "outside/escape.txt"));
  assert.equal(resolveAttachmentPath({ attachmentsDir: root, attachment: { ...attachment, sizeBytes: 5 } }), null);
  assert.deepEqual({ HOME: context.env.HOME, XDG_CONFIG_HOME: context.env.XDG_CONFIG_HOME }, before);
}));

test("native attachment lookup rejects changed registrations and files outside its owned root", async () => isolated(async () => {
  const root = providerAttachmentsDirectory();
  await mkdir(root, { recursive: true });
  const file = path.join(root, "registered.txt");
  await writeFile(file, "safe");
  const attachment: ChatAttachment = { id: "native-snapshot", type: "file", name: "registered.txt", mimeType: "text/plain", sizeBytes: 4 };
  const input = { attachmentsDir: root, attachmentId: attachment.id };
  assert.equal(resolveAttachmentPathById(input), null);
  registerProviderAttachment(attachment, "registered.txt");
  assert.equal(resolveAttachmentPathById(input), file);
  assert.equal(resolveAttachmentPathById({ ...input, attachmentId: "../native-snapshot" }), null);
  const metadata = path.join(root, ".registry", attachment.id + ".json");
  await writeFile(metadata, JSON.stringify({ attachment: { ...attachment, id: "another-id" }, relativePath: "registered.txt" }));
  assert.equal(resolveAttachmentPathById(input), null);
  registerProviderAttachment(attachment, "registered.txt");
  await writeFile(file, "changed size");
  assert.equal(resolveAttachmentPathById(input), null);
  await writeFile(file, "safe");
  const outside = path.join(process.env.AGENT_WORKSPACE_DATA_DIR!, "outside.txt");
  await writeFile(outside, "safe");
  await rm(file);
  await symlink(outside, file);
  assert.equal(resolveAttachmentPathById(input), null);
}));

test("a failed current settings read preserves the valid seed and never publishes an empty replacement", async () => isolated(async () => {
  const initial = getStoredInstance("codex")!;
  const file = path.join(process.env.AGENT_WORKSPACE_DATA_DIR!, "provider-instances.json");
  let failRead = false;
  let unreadable = false;
  let committed: string | undefined;
  const stop = subscribeProviderSettingsChanges(() => {
    if (!failRead) return;
    failRead = false;
    committed = readFileSync(file, "utf8");
    writeFileSync(file, "{");
    unreadable = true;
  });
  const settings = makePmServerSettings();
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const changes = yield* settings.subscribeChanges;
      const seeded = updateProviderInstance("codex", { label: "newer valid seed" }, initial.revision);
      const seed = yield* settings.getSettings;
      failRead = true;
      const saved = updateProviderInstance("codex", { label: "committed but unreadable event" }, seeded.revision);
      const failed = yield* settings.getSettings.pipe(Effect.result);
      assert.equal(failed._tag, "Failure");
      assert.equal(seed.providerInstances[ProviderInstanceId.make("codex")]?.displayName, seeded.label);
      assert.ok(typeof committed === "string");
      writeFileSync(file, committed);
      unreadable = false;
      const recovered = updateProviderInstance("codex", { label: "recovered current state" }, saved.revision);
      const published = yield* changes.pipe(Stream.take(2), Stream.runCollect);
      assert.deepEqual(published.map(snapshot => snapshot.providerInstances[ProviderInstanceId.make("codex")]?.displayName),
        [seeded.label, recovered.label]);
      assert.equal(getStoredInstance("codex")!.revision, recovered.revision);
    })));
  } finally {
    stop();
    if (committed !== undefined && unreadable) writeFileSync(file, committed);
  }
}));

test("a status-first retained host admits only the currently bound generation's revocable compaction authority", async () => isolated(async () => {
  const context = providerContext(updateProviderInstance("codex", { enabled: true }), process.cwd());
  assert.equal(context.execution, undefined);
  const runtimeHost = makePmProviderRuntimeHost();
  const services = makePmProviderHostServices(context, runtimeHost);
  const threadId = ThreadId.make("background-owner");
  const scope = { type: "thread" as const, threadId };
  const actions: string[] = [];
  assert.equal(await Effect.runPromise(services.shouldRunBackgroundWork({ type: "provider-status",
    instanceId: ProviderInstanceId.make(context.instanceId) })), getProviderSettings().healthRefreshIntervalSeconds > 0);
  assert.equal(await Effect.runPromise(services.shouldRunBackgroundWork(scope)), false);
  for (const executionId of ["first-generation", "next-generation"]) {
    let granted = true;
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* runtimeHost.bind(pmRuntimeBinding(context, threadId, executionId), action => Effect.suspend(() => {
        actions.push(`${executionId}:${action}`);
        return granted && action === "compaction" ? Effect.void : Effect.fail(new Error("Compaction authorization revoked."));
      }));
      assert.equal(yield* services.shouldRunBackgroundWork(scope), true);
      assert.equal(yield* services.shouldRunBackgroundWork({ type: "thread", threadId: ThreadId.make("foreign-thread") }), false);
      granted = false;
      assert.equal(yield* services.shouldRunBackgroundWork(scope), false);
    })));
    assert.equal(await Effect.runPromise(services.shouldRunBackgroundWork(scope)), false);
  }
  assert.deepEqual(actions, ["first-generation:compaction", "first-generation:compaction", "next-generation:compaction", "next-generation:compaction"]);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* runtimeHost.bind(pmRuntimeBinding(context, threadId, "no-authorization"));
    assert.equal(yield* services.shouldRunBackgroundWork(scope), false, "A technical binding without a PM grant cannot compact.");
  })));
}));

test("background admission cannot borrow a replacement generation while its original authorization is pending", async () => isolated(async () => {
  const context = providerContext(updateProviderInstance("codex", { enabled: true }), process.cwd());
  const runtimeHost = makePmProviderRuntimeHost();
  const services = makePmProviderHostServices(context, runtimeHost);
  const threadId = ThreadId.make("background-owner");
  const scope = { type: "thread" as const, threadId };
  const oldScope = await Effect.runPromise(Scope.make());
  const newScope = await Effect.runPromise(Scope.make());
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let oldGranted = true;
  let nextGranted = true;
  try {
    await Effect.runPromise(runtimeHost.bind(pmRuntimeBinding(context, threadId, "old-generation"), action =>
      Effect.promise(async () => { started.resolve(); await finish.promise; }).pipe(Effect.andThen(Effect.suspend(() =>
        oldGranted && action === "compaction" ? Effect.void : Effect.fail(new Error("Original compaction authorization revoked.")),
      ))),
    ).pipe(Effect.provideService(Scope.Scope, oldScope)));
    const pending = Effect.runPromise(services.shouldRunBackgroundWork(scope));
    await started.promise;
    await Effect.runPromise(Scope.close(oldScope, Exit.void));
    await Effect.runPromise(runtimeHost.bind(pmRuntimeBinding(context, threadId, "new-generation"), action => Effect.suspend(() =>
      nextGranted && action === "compaction" ? Effect.void : Effect.fail(new Error("Replacement authorization revoked.")),
    )).pipe(Effect.provideService(Scope.Scope, newScope)));
    finish.resolve();
    assert.equal(await pending, false, "An admitted old callback must not succeed using a replacement binding.");
    assert.equal(await Effect.runPromise(services.shouldRunBackgroundWork(scope)), true);
    nextGranted = false;
    assert.equal(await Effect.runPromise(services.shouldRunBackgroundWork(scope)), false);
    nextGranted = true;
    updateProviderInstance(context.instanceId, { label: "A newer provider revision" }, context.revision);
    assert.equal(await Effect.runPromise(services.shouldRunBackgroundWork(scope)), false);
  } finally {
    oldGranted = false;
    finish.resolve();
    await Effect.runPromise(Scope.close(oldScope, Exit.void));
    await Effect.runPromise(Scope.close(newScope, Exit.void));
  }
}));
