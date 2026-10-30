import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import * as Schema from "effect/Schema";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import {
  decodePreparedAcpRegistryAgent, resolveAcpRegistryDistribution,
  resolveAcpRegistryPlatformTarget, resolveAcpRegistryPlatformTargetCandidates,
} from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import type { ProviderDriverContext } from "../../driver-adapter.ts";
import type { ProviderConfig } from "@agent-workspace/contracts/provider";

const decodeReceipt = Schema.decodeUnknownSync(Schema.Struct({
  agent: Schema.Unknown, distribution: Schema.Literals(["binary", "npx", "uvx"]),
  fingerprint: Schema.String, commandPath: Schema.String, installRoot: Schema.String,
  packageSpec: Schema.optionalKey(Schema.String),
}));

/**
 * Parent invokes once, before starting provider workers, and persists this config with the existing
 * instance CAS. No credentials, native inference, installation, deletion or per-request fallback.
 */
export async function readPreparedAcpRegistryConfigMigration(context: ProviderDriverContext): Promise<ProviderConfig | undefined> {
  if (context.driver !== "acpRegistry") return undefined;
  const settings = Schema.decodeUnknownSync(AcpRegistrySettings)(context.config);
  if (settings.source === "local" || settings.commandPath || !settings.agentId) return undefined;
  const receiptKey = createHash("sha256").update(JSON.stringify([settings.agentId, settings.distribution])).digest("hex").slice(0, 24);
  const receiptPath = path.join(context.stateDirectory, ".acp-registry", `${receiptKey}.json`);
  let file;
  try { file = await open(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  let receipt;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid app-owned ACP preparation receipt.");
    receipt = decodeReceipt(JSON.parse(await file.readFile("utf8")));
  } finally { await file.close(); }
  const agent = decodePreparedAcpRegistryAgent(receipt.agent);
  if (agent.id !== settings.agentId) throw new Error("ACP preparation receipt belongs to another agent.");
  if (settings.distribution !== "auto" && settings.distribution !== receipt.distribution)
    throw new Error("ACP preparation receipt has another configured distribution.");
  const platformTarget = resolveAcpRegistryPlatformTarget(process.platform, process.arch);
  const selected = resolveAcpRegistryDistribution({ agent, preference: receipt.distribution, platformTarget });
  if (!selected) throw new Error("Prepared ACP distribution is not supported on this platform.");
  if (selected.kind !== "binary" && receipt.packageSpec !== selected.packageName)
    throw new Error("ACP preparation receipt has another exact native package.");
  const target = selected.kind === "binary" ? resolveAcpRegistryPlatformTargetCandidates(platformTarget)
    .find(value => agent.distribution.binary?.[value] === selected.binaryTarget) : undefined;
  // Exact previous app receipt serialization, not a new native/registry schema.
  const previousDistribution = selected.kind === "binary"
    ? { kind: selected.kind, binary: selected.binaryTarget, target, args: selected.args, env: selected.env }
    : { kind: selected.kind, packageSpec: selected.packageName, args: selected.args, env: selected.env };
  const fingerprint = createHash("sha256").update(JSON.stringify([agent.id, agent.version, previousDistribution])).digest("hex");
  if (receipt.fingerprint !== fingerprint) throw new Error("ACP preparation receipt does not match its original distribution.");
  const installRoot = path.join(context.stateDirectory, ".acp-registry", "tools", agent.id,
    encodeURIComponent(agent.version), target ?? selected.kind);
  if (receipt.installRoot !== installRoot || !path.isAbsolute(receipt.commandPath))
    throw new Error("ACP preparation receipt has an unsafe installation root.");
  for (let current = installRoot; current !== context.stateDirectory; current = path.dirname(current)) {
    if (!current.startsWith(`${context.stateDirectory}${path.sep}`)) throw new Error("ACP preparation receipt escaped its application state.");
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("ACP prepared installation contains an unsafe directory.");
  }
  const canonicalRoot = await realpath(installRoot);
  const canonicalCommand = await realpath(receipt.commandPath);
  const relative = path.relative(canonicalRoot, canonicalCommand);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    || !(await lstat(canonicalCommand)).isFile()) throw new Error("ACP prepared executable escaped its application-managed installation.");
  if (selected.kind === "binary" && path.resolve(installRoot, selected.binaryTarget!.cmd) !== receipt.commandPath)
    throw new Error("ACP prepared binary does not match its original executable.");
  return { ...context.config, commandPath: receipt.commandPath, distribution: receipt.distribution };
}
