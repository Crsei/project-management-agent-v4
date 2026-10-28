import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderCapabilities } from "@agent-workspace/contracts/provider";
import type { ProviderDriverContext } from "./driver-adapter.ts";
import { runProviderCommand } from "./process.ts";
import { codexEnvironment, codexLaunchArgs, expandNativePath } from "./drivers/codex-config.ts";

const cache = new Map<string, { expires: number; value: ProviderCapabilities }>();

/** Derive fork boundaries from the installed app-server's generated schema, not a CLI version guess. */
export async function codexProtocolCapabilities(context: ProviderDriverContext, signal?: AbortSignal): Promise<ProviderCapabilities> {
  const key = `${context.instanceId}:${context.revision}:${context.homeDirectory}`;
  const previous = cache.get(key);
  if (previous && previous.expires > Date.now()) return previous.value;
  const directory = await mkdtemp(path.join(os.tmpdir(), "workspace-codex-protocol-"));
  let fork = false; let bounded = false;
  try {
    const result = await runProviderCommand(expandNativePath(String(context.config.binaryPath || "codex")), ["app-server", ...codexLaunchArgs(context), "generate-ts", "--experimental", "--out", directory], { cwd: context.cwd, env: await codexEnvironment(context), signal, timeoutMs: 10_000 });
    if (result.code === 0) {
      const fields = await readFile(path.join(directory, "v2", "ThreadForkParams.ts"), "utf8");
      fork = /threadId\s*:/.test(fields);
      bounded = fork && /lastTurnId\??:/.test(fields);
    }
  } catch { /* A missing/older schema cannot prove fork support. Resume uses the observed native RPC. */ }
  finally { await rm(directory, { recursive: true, force: true }); }
  const value: ProviderCapabilities = { nativeResume: true, nativeFork: fork, boundedFork: bounded, modelTransition: "native", portableHandoff: true };
  if (!signal?.aborted) cache.set(key, { expires: Date.now() + 60_000, value });
  return value;
}

