import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { codexAdapter } from "./codex.ts";
import { createProviderInstance, providerContext } from "../instances.ts";
import { closeStore } from "../../durable/store.ts";
import { startPmProviderApplication, stopPmProviderApplication } from "../t3code/application.ts";
import { getPmProviderApplication } from "../t3code/application-access.ts";
import { codexDriver, makeCodexDriverLayer, codexProtocolResolver, codexCapabilities, codexInstallationMethods } from "../t3code/families/codex.ts";
import { makePmProviderFamily } from "../t3code/registration.ts";

/** Parent-only real-account gate; never executed during implementation.
 * Run from repository root:
 * node --conditions=development apps/server/agent/src/providers/drivers/codex-real-smoke.ts --authorize-native-account --model MODEL [--binary /absolute/codex] [--home /authorized/CODEX_HOME]
 * Requires an already authorized native CLI/environment, supported pinned app-server-v2 metadata/fork APIs,
 * the explicitly selected model, actual endpoint access and sufficient account quota. No login, install,
 * update, .env/access-file read, credential import, global Home scan or service restart occurs here.
 * Native CLI alone may consume its pre-authorized environment. A requiresOpenaiAuth=false custom endpoint
 * is allowed without inventing authenticated identity. Managed OAuth/broker additionally requires an
 * explicitly connected PM-owned ChatGPT profile with chatgpt.tokens.use.direct and the built token helper;
 * validate that separately through PM settings before using managed Chat. Prior OAuth403 is not evidence.
 * This direct native gate does not claim HTTP/SSE/browser or PM business tool verification.
 */
const { values } = parseArgs({ strict: true, options: {
  "authorize-native-account": { type: "boolean", default: false }, model: { type: "string" },
  binary: { type: "string", default: "codex" }, home: { type: "string", default: "" },
} });
if (!values["authorize-native-account"] || !values.model?.trim()) throw new Error("Explicit --authorize-native-account and --model are required; no account or model inference.");
const root = await mkdtemp(path.join(os.tmpdir(), "pm-codex-real-m4-"));
const previousData = process.env.AGENT_WORKSPACE_DATA_DIR;
process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "agent-data");
let phase = "initialize";
let stopped = false;
try {
  const cwd = path.join(root, "workspace"); await mkdir(cwd);
  const instance = createProviderInstance({ instanceId: "codex-real-m4", driver: "codex", label: "Disposable actual Codex M4",
    config: { binaryPath: values.binary, homePath: values.home, setupMode: "existing" } });
  await startPmProviderApplication({ families: new Map([[codexDriver.driverKind, makePmProviderFamily(codexDriver, makeCodexDriverLayer)]]),
    protocols: new Map([["codex", codexProtocolResolver]]), capabilities: new Map([["codex", codexCapabilities]]),
    installations: new Map([["codex", codexInstallationMethods]]) });
  const context = providerContext(instance, cwd);
  phase = "settings-check";
  const status = await codexAdapter.check(context);
  assert.equal(status.nativeSessionReady, true, "Native readiness is required independently of identity.");
  assert.ok(status.models.some(model => model.id === values.model), "The explicit model must be present in the actual native inventory.");
  const a = randomInt(11, 80), b = randomInt(13, 90), c = randomInt(100, 900);
  const expected = a * b + c;
  phase = "actual-inference";
  const first = await codexAdapter.run(context, { model: values.model, prompt: `Compute (${a} * ${b}) + ${c}. Reply with the decimal integer only. Do not use tools or modify files.`, signal: AbortSignal.timeout(180000) });
  assert.equal(first.text.trim(), String(expected)); assert.ok(first.nativeSession?.turnId);
  phase = "same-session-continuation";
  const continuation = await codexAdapter.run(context, { model: values.model, resume: first.nativeSession,
    prompt: "Add one to the integer you just returned. Reply with the decimal integer only. Do not use tools or modify files.", signal: AbortSignal.timeout(180000) });
  assert.equal(continuation.text.trim(), String(expected + 1)); assert.equal(continuation.nativeSession?.sessionId, first.nativeSession.sessionId);
  phase = "completed-historical-fork";
  const fork = await getPmProviderApplication().execution.fork(context, first.nativeSession, { turnId: first.nativeSession.turnId }, AbortSignal.timeout(60000));
  assert.notEqual(fork.sessionId, first.nativeSession.sessionId);
  const forked = await codexAdapter.run(context, { model: values.model, resume: fork,
    prompt: "Repeat the decimal integer in your latest assistant reply, exactly. Do not use tools or modify files.", signal: AbortSignal.timeout(180000) });
  assert.equal(forked.text.trim(), String(expected)); assert.equal(forked.nativeSession?.sessionId, fork.sessionId);
  console.log(JSON.stringify({ family: "codex", protocol: "codex-app-server-v2.jsonrpc", nativeReadiness: true,
    accountIdentity: status.authentication, model: values.model, actualArithmetic: true, sameNativeSession: true,
    historicalCompletedTurnFork: true, nativeUsagePresent: Boolean(first.usage), httpSseBrowserVerified: false }));
} catch (error) {
  const details = error && typeof error === "object" ? error : {};
  console.error(JSON.stringify({ family: "codex", phase, result: "failed",
    ...("code" in details && typeof details.code === "string" ? { code: details.code } : {}),
    ...("errorClass" in details && typeof details.errorClass === "string" ? { errorClass: details.errorClass } : {}) }));
  process.exitCode = 1;
} finally {
  try { await stopPmProviderApplication(); stopped = true; }
  finally {
    if (stopped) { closeStore(); await rm(root, { recursive: true, force: true }); }
    if (previousData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousData;
  }
}
