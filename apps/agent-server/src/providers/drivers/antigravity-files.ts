// Ported from t3code provider/acp/AntigravityClientFiles.ts (MIT).
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AcpError, acpRecord } from "./acp.ts";
const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;

async function resolveClientFilePath(cwd: string, requestPath: unknown): Promise<string> {
  if (typeof requestPath !== "string" || !requestPath || requestPath.includes("\0")) throw new AcpError("Invalid Antigravity workspace file path.", -32602);
  const resolved = resolve(cwd, requestPath);
  const outside = () => new AcpError("The requested file is outside the session workspace or traverses an unresolved link.", -32602);
  const missing: string[] = []; let candidate = resolved; let canonical: string;
  for (;;) {
    try { canonical = await realpath(candidate); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw outside();
      // A dangling symlink must not become a new write. Resolve the nearest existing
      // ancestor for new nested files instead of trusting a lexical parent prefix.
      const entry = await lstat(candidate).catch((cause: NodeJS.ErrnoException) => { if (cause.code === "ENOENT") return null; throw outside(); });
      if (entry || dirname(candidate) === candidate) throw outside();
      missing.unshift(basename(candidate)); candidate = dirname(candidate);
    }
  }
  const path = join(canonical, ...missing); const root = await realpath(cwd); const within = relative(root, path);
  if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw outside();
  return path;
}
export async function handleAntigravityClientRequest(method: string, params: Record<string, unknown>, cwd: string, sessionId: string): Promise<unknown> {
  if (!sessionId || params.sessionId !== sessionId) throw new AcpError("The Antigravity client request does not belong to this session.", -32602);
  if (method === "session/request_permission") {
    // This integration has no authorized approval channel. Native interaction_ questions
    // are not permissions and must never select an answer on the user's behalf.
    const userQuestion = String(acpRecord(params.toolCall).toolCallId ?? "").startsWith("interaction_");
    const options = Array.isArray(params.options) ? params.options.map(acpRecord) : [];
    const denied = userQuestion ? undefined : options.find((option) => option.kind === "reject_once" && typeof option.optionId === "string" && option.optionId.trim());
    return { outcome: denied ? { outcome: "selected", optionId: denied.optionId } : { outcome: "cancelled" } };
  }
  if (method !== "fs/read_text_file" && method !== "fs/write_text_file") throw new AcpError(`Antigravity client method is unavailable: ${method}.`, -32601);
  const path = await resolveClientFilePath(cwd, params.path);
  if (method === "fs/read_text_file") {
    const entry = await stat(path).catch(() => { throw new AcpError("The requested Antigravity workspace file was not found.", -32002); });
    if (!entry.isFile() || entry.size > CLIENT_FILE_MAX_BYTES) throw new AcpError(`The requested file is not a readable text file under ${CLIENT_FILE_MAX_BYTES} bytes.`, -32602);
    const text = await readFile(path, "utf8");
    if (params.line === undefined && params.limit === undefined) return { content: text };
    if ((params.line !== undefined && (!Number.isSafeInteger(params.line) || Number(params.line) < 1)) || (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) < 0))) throw new AcpError("Invalid Antigravity file line range.", -32602);
    const lines = text.split("\n"); const start = Math.max(0, Number(params.line ?? 1) - 1); const end = params.limit === undefined ? lines.length : Math.min(lines.length, start + Number(params.limit));
    return { content: lines.slice(start, end).join("\n") };
  }
  if (typeof params.content !== "string") throw new AcpError("Antigravity file content must be text.", -32602);
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, params.content); return {};
}
