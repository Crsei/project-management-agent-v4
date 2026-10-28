// Registry schema, ranking, distribution selection, managed package receipts and
// preparation ported from t3code/packages/provider-acp-registry/src/server/AcpRegistrySupport.ts (MIT).
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, constants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import * as tar from "tar";
import * as yauzl from "yauzl";
import { z } from "zod";
import type { ProviderConfig } from "@agent-workspace/contracts/provider";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { runProviderCommand } from "../process.ts";
import { AcpError, type AcpSpawn } from "./acp.ts";

export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 2 * MAX_ARCHIVE_BYTES;
const MAX_ENTRIES = 20_000;
const exactVersion = "v?[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";
const npxSpec = new RegExp(`^(?:@[^/@\\s]+/[^@\\s]+|[a-z0-9][a-z0-9._-]*)@${exactVersion}$`, "i");
const uvxSpec = new RegExp(`^[a-z0-9][a-z0-9._-]*(?:@|==)${exactVersion}$`, "i");
const httpsUrl = z.string().max(2048).refine((value) => { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; } }, "Registry URLs must use HTTPS without credentials.");
const argument = z.string().max(1024).refine((value) => !value.includes("\0"));
const distributionFields = { args: z.array(argument).max(64).optional(), env: z.record(z.string().max(256), argument).optional() };
const binarySchema = z.object({ archive: httpsUrl, cmd: argument, sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(), ...distributionFields });
const agentSchema = z.object({
  id: z.string().max(128).regex(/^[a-z0-9][a-z0-9._-]*$/), name: z.string().trim().min(1).max(160),
  version: z.string().max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/), description: z.string().max(1024),
  authors: z.array(z.string().max(256)).max(16).optional(), license: z.string().max(128).optional(), website: httpsUrl.optional(), repository: httpsUrl.optional(), icon: httpsUrl.optional(),
  distribution: z.object({ binary: z.record(z.string(), binarySchema).optional(), npx: z.object({ package: z.string().max(256).regex(npxSpec), ...distributionFields }).optional(), uvx: z.object({ package: z.string().max(256).regex(uvxSpec), ...distributionFields }).optional() }),
});
export type AcpRegistryAgent = z.infer<typeof agentSchema>;
export type AcpDistributionKind = "binary" | "npx" | "uvx";
export type AcpRegistrySearchEntry = Omit<AcpRegistryAgent, "distribution"> & { distributions: AcpDistributionKind[] };
export type AcpRegistryResolved = { agentId: string; version: string | null; distribution: AcpDistributionKind | "local"; commandPath: string; spawn: AcpSpawn; agent?: AcpRegistryAgent };
type Distribution = { kind: AcpDistributionKind; args: string[]; env: Record<string, string>; binary?: z.infer<typeof binarySchema>; packageSpec?: string; target?: string };
type Receipt = { agent: AcpRegistryAgent; distribution: AcpDistributionKind; fingerprint: string; commandPath: string; installRoot: string; packageSpec?: string };

export function decodeAcpRegistryIndex(value: unknown): AcpRegistryAgent[] {
  const index = z.object({ version: z.string().max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/), agents: z.array(z.unknown()).max(512) }).parse(value);
  const agents = new Map<string, AcpRegistryAgent>();
  for (const candidate of index.agents) { const decoded = agentSchema.safeParse(candidate); if (decoded.success && !agents.has(decoded.data.id)) agents.set(decoded.data.id, decoded.data); }
  return [...agents.values()];
}
export function registryCommandSegments(command: string): string[] {
  const normalized = command.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || segments.some((segment) => segment === "." || segment === ".." || segment.includes("\0"))) throw new AcpError("ACP registry contains an unsafe archive or executable path.");
  return segments;
}
export function selectAcpRegistryDistribution(agent: AcpRegistryAgent, preference = "auto", platform: NodeJS.Platform = process.platform, architecture: string = process.arch): Distribution {
  const os = platform === "win32" ? "windows" : ["darwin", "linux"].includes(platform) ? platform : "";
  const arch = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : "";
  const target = os && arch ? `${os}-${arch}` : "";
  const targets = target === "windows-aarch64" ? [target, "windows-x86_64"] : [target];
  for (const kind of preference === "auto" ? ["binary", "npx", "uvx"] : [preference]) {
    if (kind === "binary") for (const candidate of targets) { const binary = agent.distribution.binary?.[candidate]; if (binary) return { kind, binary, target: candidate, args: binary.args ?? [], env: binary.env ?? {} }; }
    if (kind === "npx" || kind === "uvx") { const distribution = agent.distribution[kind]; if (distribution) return { kind, packageSpec: distribution.package, args: distribution.args ?? [], env: distribution.env ?? {} }; }
  }
  throw new AcpError(`ACP registry agent '${agent.id}' has no compatible ${preference} distribution.`);
}
export function rankAcpRegistryAgent(agent: AcpRegistryAgent, query: string): number | undefined {
  const normalized = query.trim().toLowerCase(); if (!normalized) return 100;
  const id = agent.id.toLowerCase(); const name = agent.name.toLowerCase(); const authors = (agent.authors ?? []).join(" ").toLowerCase(); const terms = normalized.split(/\s+/);
  if (id === normalized || name === normalized) return 0;
  if (id.startsWith(normalized) || name.startsWith(normalized)) return 10;
  const tokens = `${id} ${name}`.split(/[^a-z0-9]+/).filter(Boolean);
  if (terms.every((term) => tokens.some((token) => token.startsWith(term)))) return 20;
  if (terms.every((term) => id.includes(term) || name.includes(term))) return 30;
  if (terms.every((term) => authors.includes(term))) return 40;
  if (terms.every((term) => `${id} ${name} ${authors} ${agent.description.toLowerCase()}`.includes(term))) return 50;
  return undefined;
}

async function registryResponse(input: string, signal?: AbortSignal): Promise<Response> {
  let url = httpsUrl.parse(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location"); await response.body?.cancel();
      if (!location) throw new AcpError("Registry download redirect omitted its location.");
      url = httpsUrl.parse(new URL(location, url).href); continue;
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new AcpError(`ACP registry request failed (${response.status}).`); }
    return response;
  }
  throw new AcpError("Too many ACP registry download redirects.");
}
let indexCache: { agents: AcpRegistryAgent[]; expiresAt: number } | undefined;
async function fetchIndex(signal?: AbortSignal): Promise<AcpRegistryAgent[]> {
  if (indexCache && indexCache.expiresAt > Date.now()) return indexCache.agents;
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const response = await registryResponse(ACP_REGISTRY_URL, requestSignal);
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try { while (true) { const result = await reader.read(); if (result.done) break; bytes += result.value.byteLength; if (bytes > MAX_REGISTRY_BYTES) throw new AcpError("ACP registry index is too large."); chunks.push(result.value); } } finally { await reader.cancel().catch(() => {}); }
  const agents = decodeAcpRegistryIndex(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  indexCache = { agents, expiresAt: Date.now() + 5 * 60_000 }; return agents;
}
export async function searchAcpRegistry(input: { query?: string; limit?: number; signal?: AbortSignal } = {}): Promise<{ agents: AcpRegistrySearchEntry[]; total: number }> {
  const query = (input.query ?? "").slice(0, 120); const limit = Math.max(1, Math.min(Number.isFinite(input.limit) ? Math.trunc(input.limit!) : 20, 512));
  const ranked = (await fetchIndex(input.signal)).flatMap((agent) => { const rank = rankAcpRegistryAgent(agent, query); return rank === undefined ? [] : [{ agent, rank }]; }).sort((a, b) => a.rank - b.rank || a.agent.name.localeCompare(b.agent.name) || a.agent.id.localeCompare(b.agent.id));
  return { total: ranked.length, agents: ranked.slice(0, limit).map(({ agent: { distribution, ...agent } }) => ({ ...agent, distributions: (["binary", "npx", "uvx"] as const).filter((kind) => distribution[kind]) })) };
}

export async function resolveAcpExecutable(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  if (!command || command.includes("\0")) throw new AcpError("Configure an ACP executable.");
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) throw new AcpError("ACP requires a native executable, not a Windows shell script.");
  const candidates = command.includes("/") || command.includes("\\") ? [path.resolve(cwd, command)] : (env.PATH ?? "").split(path.delimiter).filter(Boolean).flatMap((directory) => process.platform === "win32" ? [path.join(directory, command), path.join(directory, `${command}.exe`)] : [path.join(directory, command)]);
  for (const candidate of candidates) try { await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK); if ((await stat(candidate)).isFile()) return candidate; } catch { /* Try the next PATH entry. */ }
  throw new AcpError(`ACP executable '${command}' is not installed or executable.`);
}
async function managedDirectory(home: string, relative: string, create: boolean): Promise<string> {
  if (create) await mkdir(home, { recursive: true, mode: 0o700 });
  const segments = registryCommandSegments(relative);
  let current = home;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (create) await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new AcpError("ACP managed installation directories must not be symlinks or special files.");
  }
  return current;
}
function receiptPath(context: ProviderDriverContext): string {
  const key = createHash("sha256").update(JSON.stringify([context.config.agentId, context.config.distribution ?? "auto"])).digest("hex").slice(0, 24);
  return path.join(context.homeDirectory, ".acp-registry", `${key}.json`);
}
function fingerprint(agent: AcpRegistryAgent, distribution: Distribution): string { return createHash("sha256").update(JSON.stringify([agent.id, agent.version, distribution])).digest("hex"); }
async function containedExecutable(root: string, executable: string): Promise<string> {
  const realRoot = await realpath(root); const target = await realpath(executable); const relative = path.relative(realRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await stat(target)).isFile()) throw new AcpError("ACP registry executable escapes its managed installation.");
  await access(target, process.platform === "win32" ? constants.F_OK : constants.X_OK); return executable;
}
function distributionEnvironment(context: ProviderDriverContext, distribution: Distribution, executable: string): NodeJS.ProcessEnv {
  // Registry-provided env never substitutes another user's home or loader configuration.
  const env = { ...context.env };
  for (const [key, value] of Object.entries(distribution.env)) if (!/^(?:HOME|USERPROFILE|GROK_HOME|XDG_.*|NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/.test(key)) env[key] = value;
  env.PATH = `${path.dirname(executable)}${path.delimiter}${context.env.PATH ?? ""}`;
  return env;
}
export async function resolveAcpRegistry(context: ProviderDriverContext, signal?: AbortSignal): Promise<AcpRegistryResolved> {
  if (signal?.aborted) throw new DOMException("ACP resolution cancelled.", "AbortError");
  const config = context.config;
  if (config.source === "local") {
    const commandPath = await resolveAcpExecutable(String(config.commandPath ?? ""), context.env, context.cwd);
    return { agentId: "", version: null, distribution: "local", commandPath, spawn: { command: commandPath, args: Array.isArray(config.commandArgs) ? config.commandArgs : [], env: context.env } };
  }
  if (!config.agentId) throw new AcpError("Select an ACP Registry agent before preparing this provider.");
  let receipt: Receipt | undefined;
  try { receipt = JSON.parse(await readFile(receiptPath(context), "utf8")) as Receipt; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AcpError("ACP installation receipt is invalid; explicitly prepare this provider again."); }
  // An explicit executable override preserves official distribution args/environment but never installs.
  if (config.commandPath) {
    const agent = (await fetchIndex(signal)).find((candidate) => candidate.id === config.agentId);
    if (!agent) throw new AcpError(`ACP registry agent '${String(config.agentId)}' was not found.`);
    const distribution = selectAcpRegistryDistribution(agent, String(config.distribution ?? "auto"));
    const commandPath = await resolveAcpExecutable(String(config.commandPath), context.env, context.cwd);
    return { agentId: agent.id, version: agent.version, distribution: distribution.kind, commandPath, agent, spawn: { command: commandPath, args: distribution.args, env: distributionEnvironment(context, distribution, commandPath) } };
  }
  if (!receipt) throw new AcpError("ACP agent is not prepared. Use the explicit Prepare agent action to download/install it.");
  const agent = agentSchema.parse(receipt.agent);
  if (agent.id !== config.agentId) throw new AcpError("ACP installation receipt belongs to a different agent.");
  const distribution = selectAcpRegistryDistribution(agent, String(config.distribution ?? "auto"));
  if (receipt.distribution !== distribution.kind || receipt.fingerprint !== fingerprint(agent, distribution)) throw new AcpError("ACP installation receipt does not match its distribution.");
  const expectedRoot = path.join(context.homeDirectory, ".acp-registry", "tools", agent.id, encodeURIComponent(agent.version), distribution.kind === "binary" ? distribution.target! : distribution.kind);
  if (receipt.installRoot !== expectedRoot) throw new AcpError("ACP installation receipt has an unsafe root.");
  await managedDirectory(context.homeDirectory, path.relative(context.homeDirectory, expectedRoot), false);
  const commandPath = await containedExecutable(expectedRoot, receipt.commandPath);
  const expectedCommand = distribution.kind === "binary"
    ? path.join(expectedRoot, ...registryCommandSegments(distribution.binary!.cmd))
    : distribution.kind === "npx"
      ? await npmExecutable(expectedRoot, agent, distribution.packageSpec!)
      : await uvExecutable(expectedRoot, agent, distribution.packageSpec!, context, signal);
  if (commandPath !== expectedCommand) throw new AcpError("ACP receipt executable does not match its exact registry distribution.");
  return { agentId: agent.id, version: agent.version, distribution: distribution.kind, commandPath, agent, spawn: { command: commandPath, args: distribution.args, env: distributionEnvironment(context, distribution, commandPath) } };
}

async function downloadArchive(url: string, destination: string, expectedHash: string | undefined, signal: AbortSignal): Promise<void> {
  const response = await registryResponse(url, signal);
  const reader = response.body!.getReader(); const hash = createHash("sha256"); let bytes = 0;
  const file = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  async function* chunks() { try { while (true) { const result = await reader.read(); if (result.done) return; bytes += result.value.byteLength; if (bytes > MAX_ARCHIVE_BYTES) throw new AcpError("ACP registry archive exceeds its download limit."); hash.update(result.value); yield result.value; } } finally { await reader.cancel().catch(() => {}); } }
  await pipeline(chunks(), file, { signal });
  if (expectedHash && hash.digest("hex") !== expectedHash.toLowerCase()) throw new AcpError("ACP registry download did not match its declared SHA-256.");
}
async function extractZip(archive: string, destination: string, signal: AbortSignal): Promise<void> {
  const opened = Promise.withResolvers<yauzl.ZipFile>();
  yauzl.open(archive, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, file) => error || !file ? opened.reject(error ?? new AcpError("Invalid ACP ZIP archive.")) : opened.resolve(file));
  const zip = await opened.promise; const complete = Promise.withResolvers<void>(); let count = 0; let expanded = 0;
  const abort = () => complete.reject(new DOMException("ACP preparation cancelled.", "AbortError"));
  signal.addEventListener("abort", abort, { once: true });
  zip.on("error", complete.reject); zip.once("end", complete.resolve);
  zip.on("entry", (entry: yauzl.Entry) => {
    void (async () => {
      if (signal.aborted) throw new DOMException("ACP preparation cancelled.", "AbortError");
      const segments = registryCommandSegments(entry.fileName); const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (![0, 0o100000, 0o040000].includes(mode) || (entry.generalPurposeBitFlag & 1) !== 0 || ++count > MAX_ENTRIES || (expanded += entry.uncompressedSize) > MAX_EXPANDED_BYTES) throw new AcpError("ACP ZIP archive contains unsafe entries or exceeds extraction limits.");
      const target = path.join(destination, ...segments);
      if (entry.fileName.endsWith("/")) await mkdir(target, { recursive: true });
      else {
        await mkdir(path.dirname(target), { recursive: true });
        const stream = Promise.withResolvers<Readable>();
        zip.openReadStream(entry, (error, readable) => error || !readable ? stream.reject(error ?? new AcpError("Invalid ACP ZIP entry.")) : stream.resolve(readable));
        await pipeline(await stream.promise, createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal });
      }
      zip.readEntry();
    })().catch(complete.reject);
  });
  zip.readEntry();
  try { await complete.promise; } finally { signal.removeEventListener("abort", abort); zip.close(); }
}
async function extractArchive(archive: string, url: string, command: string, destination: string, context: ProviderDriverContext, signal: AbortSignal): Promise<void> {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".zip")) return extractZip(archive, destination, signal);
  if (!/\.(?:tar\.gz|tgz|tar\.bz2|tbz2|tar)$/.test(pathname)) {
    const executable = path.join(destination, ...registryCommandSegments(command)); await mkdir(path.dirname(executable), { recursive: true }); await rename(archive, executable); return;
  }
  let input = archive;
  if (/\.(?:tar\.bz2|tbz2)$/.test(pathname)) {
    input = `${archive}.tar`; const child = spawn("bzip2", ["-dc", archive], { env: context.env, cwd: context.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const exit = Promise.withResolvers<void>(); let errorOutput = "";
    child.stderr.on("data", (chunk: Buffer) => { errorOutput = (errorOutput + chunk.toString()).slice(-1024); });
    child.once("error", exit.reject); child.once("close", (code) => code === 0 ? exit.resolve() : exit.reject(new AcpError(`ACP bzip2 decompression failed: ${errorOutput}`)));
    let size = 0; const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) { size += chunk.length; callback(size > MAX_EXPANDED_BYTES ? new AcpError("ACP archive exceeds decompression limits.") : null, chunk); } });
    try { await Promise.all([pipeline(child.stdout, bounded, createWriteStream(input, { flags: "wx" }), { signal }), exit.promise]); } finally { child.kill("SIGKILL"); }
  }
  let count = 0; let expanded = 0;
  const listing = tar.t({ strict: true });
  listing.on("entry", (entry: { path: string; type: string; size: number }) => {
    try {
      if (entry.path === "./") return;
      registryCommandSegments(entry.path);
      if (!["File", "Directory", "OldFile"].includes(entry.type) || ++count > MAX_ENTRIES || (expanded += entry.size) > MAX_EXPANDED_BYTES) throw new AcpError("ACP tar archive contains links/special entries or exceeds extraction limits.");
    } catch (error) { listing.abort(error instanceof Error ? error : new AcpError("Unsafe ACP archive entry.")); }
  });
  await pipeline(createReadStream(input), listing, { signal });
  const extraction = tar.x({ cwd: destination, strict: true, preservePaths: false, noChmod: true, noMtime: true, filter(_entryPath, entry) { return "type" in entry && ["File", "Directory", "OldFile"].includes(entry.type); } });
  await pipeline(createReadStream(input), extraction, { signal });
  if (signal.aborted) throw new DOMException("ACP preparation cancelled.", "AbortError");
}

async function npmExecutable(root: string, agent: AcpRegistryAgent, spec: string): Promise<string> {
  const separator = spec.lastIndexOf("@"); const name = spec.slice(0, separator); const version = spec.slice(separator + 1).replace(/^v/i, "");
  const packageRoot = path.join(root, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", ...name.split("/"));
  const file = path.join(packageRoot, "package.json"); if ((await stat(file)).size > 1024 * 1024) throw new AcpError("ACP npm manifest is too large.");
  const manifest = z.object({ name: z.string(), version: z.string(), bin: z.union([z.string(), z.record(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i), z.string())]) }).parse(JSON.parse(await readFile(file, "utf8")));
  if (manifest.name !== name || manifest.version !== version) throw new AcpError("ACP npm installation does not match its exact registry package version.");
  const baseName = name.split("/").pop()!; let command: string | undefined;
  if (typeof manifest.bin === "string") command = baseName;
  else { const entries = Object.entries(manifest.bin).sort(([a], [b]) => a.localeCompare(b)); command = entries.length === 1 ? entries[0]![0] : manifest.bin[baseName] ? baseName : manifest.bin[agent.id] ? agent.id : new Set(entries.map(([, target]) => target)).size === 1 ? entries[0]?.[0] : undefined; }
  if (!command) throw new AcpError("ACP npm package has ambiguous executable names.");
  const target = typeof manifest.bin === "string" ? manifest.bin : manifest.bin[command]!;
  registryCommandSegments(target);
  const actual = path.join(packageRoot, ...registryCommandSegments(target));
  await containedExecutable(root, actual);
  // Use the actual entrypoint on Windows when it is native; .cmd wrappers are deliberately rejected.
  const executable = process.platform === "win32" ? actual : path.join(root, "bin", command);
  return containedExecutable(root, executable);
}
async function uvExecutable(root: string, agent: AcpRegistryAgent, packageSpec: string, context: ProviderDriverContext, signal?: AbortSignal): Promise<string> {
  const manager = await resolveAcpExecutable("uv", context.env, context.cwd);
  const bin = path.join(root, "bin");
  const env = { ...context.env, UV_TOOL_DIR: root, UV_TOOL_BIN_DIR: bin, UV_CACHE_DIR: path.join(context.homeDirectory, ".acp-registry", "uv-cache") };
  const listing = await runProviderCommand(manager, ["tool", "list"], { cwd: context.cwd, env, signal, timeoutMs: 30_000, maxOutput: 1024 * 1024 });
  const separator = packageSpec.includes("==") ? packageSpec.lastIndexOf("==") : packageSpec.lastIndexOf("@");
  const name = packageSpec.slice(0, separator); const version = packageSpec.slice(separator + (packageSpec.includes("==") ? 2 : 1)).replace(/^v/i, "");
  const normalizedName = name.toLowerCase().replace(/[._-]+/g, "-");
  const exactVersion = listing.stdout.split(/\r?\n/).some((line) => {
    const match = /^(\S+) v(\S+)(?:\s|$)/.exec(line);
    return match?.[1]?.toLowerCase().replace(/[._-]+/g, "-") === normalizedName && match?.[2] === version;
  });
  if (listing.code !== 0 || !exactVersion) throw new AcpError("ACP uv tool installation does not match its exact registry version.");
  const candidates = [...new Set([agent.id, name, name.replace(/-acp$/, "")])];
  for (const command of candidates) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(command)) continue;
    try { return await containedExecutable(root, path.join(bin, `${command}${process.platform === "win32" ? ".exe" : ""}`)); } catch { /* Try the next source-defined executable candidate. */ }
  }
  throw new AcpError("ACP uv tool installation has no matching native executable.");
}
async function installPackage(root: string, agent: AcpRegistryAgent, distribution: Distribution, context: ProviderDriverContext, signal: AbortSignal): Promise<string> {
  const npm = distribution.kind === "npx"; const manager = await resolveAcpExecutable(npm ? "npm" : "uv", context.env, context.cwd);
  const bin = path.join(root, "bin");
  await managedDirectory(context.homeDirectory, path.relative(context.homeDirectory, root), true);
  await managedDirectory(context.homeDirectory, path.join(".acp-registry", npm ? "npm-cache" : "uv-cache"), true);
  try { return npm ? await npmExecutable(root, agent, distribution.packageSpec!) : await uvExecutable(root, agent, distribution.packageSpec!, context, signal); } catch (error) {
    if (signal.aborted) throw error;
    // Explicit preparation repairs an incomplete or mismatched managed package.
  }
  const env = { ...context.env, ...(npm ? { npm_config_prefix: root, npm_config_cache: path.join(context.homeDirectory, ".acp-registry", "npm-cache") } : { UV_TOOL_DIR: root, UV_TOOL_BIN_DIR: bin, UV_CACHE_DIR: path.join(context.homeDirectory, ".acp-registry", "uv-cache") }) };
  const result = await runProviderCommand(manager, npm ? ["install", "--global", distribution.packageSpec!] : ["tool", "install", "--force", distribution.packageSpec!], { cwd: context.cwd, env, signal, timeoutMs: 20 * 60_000, maxOutput: 64 * 1024 });
  if (signal.aborted) throw new DOMException("ACP preparation cancelled.", "AbortError");
  if (result.code !== 0) throw new AcpError(`ACP package installation failed: ${result.stderr || result.stdout}`);
  if (npm) return npmExecutable(root, agent, distribution.packageSpec!);
  return uvExecutable(root, agent, distribution.packageSpec!, context, signal);
}

const preparationLocks = new Map<string, Promise<AcpRegistryResolved>>();
export async function prepareAcpRegistry(context: ProviderDriverContext, signal?: AbortSignal): Promise<AcpRegistryResolved> {
  if (context.config.source === "local" || context.config.commandPath) return resolveAcpRegistry(context, signal);
  const key = receiptPath(context); const existing = preparationLocks.get(key); if (existing) return existing;
  const operation = prepare(context, signal); preparationLocks.set(key, operation);
  try { return await operation; } finally { if (preparationLocks.get(key) === operation) preparationLocks.delete(key); }
}
async function prepare(context: ProviderDriverContext, signal?: AbortSignal): Promise<AcpRegistryResolved> {
  const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20 * 60_000)]) : AbortSignal.timeout(20 * 60_000);
  const agent = (await fetchIndex(operationSignal)).find((candidate) => candidate.id === context.config.agentId);
  if (!agent) throw new AcpError(`ACP registry agent '${String(context.config.agentId ?? "")}' was not found.`);
  const distribution = selectAcpRegistryDistribution(agent, String(context.config.distribution ?? "auto"));
  const root = path.join(context.homeDirectory, ".acp-registry", "tools", agent.id, encodeURIComponent(agent.version), distribution.kind === "binary" ? distribution.target! : distribution.kind);
  await managedDirectory(context.homeDirectory, path.relative(context.homeDirectory, root), true);
  let commandPath: string;
  if (distribution.kind === "binary") {
    const binary = distribution.binary!; const segments = registryCommandSegments(binary.cmd); commandPath = path.join(root, ...segments);
    try { await containedExecutable(root, commandPath); } catch {
      const temporary = await mkdtemp(path.join(path.dirname(root), ".prepare-"));
      try {
        const archive = path.join(temporary, "archive"); const extraction = path.join(temporary, "extracted"); await mkdir(extraction, { mode: 0o700 });
        await downloadArchive(binary.archive, archive, binary.sha256, operationSignal);
        await extractArchive(archive, binary.archive, binary.cmd, extraction, context, operationSignal);
        const executable = path.join(extraction, ...segments); if ((await lstat(executable)).isSymbolicLink()) throw new AcpError("ACP archive executable must not be a symlink.");
        await chmod(executable, 0o755); await containedExecutable(extraction, executable);
        // Only replace this provider's exact managed installation, never any user command.
        await rm(root, { recursive: true, force: true }); await rename(extraction, root);
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
  } else commandPath = await installPackage(root, agent, distribution, context, operationSignal);
  await containedExecutable(root, commandPath);
  const receipt: Receipt = { agent, distribution: distribution.kind, fingerprint: fingerprint(agent, distribution), commandPath, installRoot: root, ...(distribution.packageSpec ? { packageSpec: distribution.packageSpec } : {}) };
  const destination = receiptPath(context); await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); const temporary = `${destination}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 }); await rename(temporary, destination); } finally { await rm(temporary, { force: true }); }
  return resolveAcpRegistry(context, operationSignal);
}

export function validateAcpRegistryConfig(config: ProviderConfig): ProviderConfig {
  const command = z.string().refine((value) => !value.includes("\0"));
  const schema = z.object({
    source: z.enum(["registry", "local"]).default("registry"),
    agentId: z.string().trim().default(""),
    commandPath: command.transform((value) => value.trim()).default(""),
    commandArgs: z.array(command).default([]),
    authMethodId: z.string().trim().default(""),
    distribution: z.enum(["auto", "binary", "npx", "uvx"]).default("auto"),
  }).strict();
  return schema.parse(config);
}
