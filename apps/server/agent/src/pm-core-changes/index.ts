import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AgentScope } from "@agent-workspace/contracts/chat";
import type { PmCoreChange, PmCoreChangesPage, PmCoreObservation } from "@agent-workspace/contracts/pm-core-changes";
import { getDatabase, readRecord, writeRecord, deleteRecord, transaction } from "../durable/store.ts";

const scopeSchema = z.strictObject({ workspaceId: z.uuid(), projectId: z.string().regex(/^PRJ-\d+$/).nullable() });
const sourceSchema = z.object({ files: z.array(z.object({ path: z.string().min(1).max(4096), projectId: z.string(), entityId: z.string().nullable(), content: z.string().max(4 * 1024 * 1024) })).max(10000), complete: z.boolean(), error: z.string().max(1000).optional() });
const catalogSchema = z.object({ workspaces: z.array(z.object({ id: z.string(), projects: z.array(z.object({ id: z.string().regex(/^PRJ-\d+$/) })).max(10000) })).max(10000) });
type RequestHeaders = NonNullable<RequestInit["headers"]>;
type ProjectScope = { workspaceId: string; projectId: string };
type Snapshot = { path: string; entityId: string | null; hash: string; content: string };
const snapshotNs = (s: ProjectScope) => `pm-core:snapshot:${s.workspaceId}:${s.projectId}`;
const changesNs = (s: ProjectScope) => `pm-core:changes:${s.workspaceId}:${s.projectId}`;
const scopeKey = (s: ProjectScope) => `${s.workspaceId}:${s.projectId}`;
const stateNs = "pm-core:observation";
const digest = (content: string) => createHash("sha256").update(content).digest("hex");

class ObservationError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function pmUrl(path: string): URL {
  try {
    const base = new URL(process.env.PM_API_URL?.trim() || "http://127.0.0.1:4194");
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error();
    return new URL(path, base.origin);
  } catch { throw new ObservationError(503, "PM API address is invalid."); }
}
function authHeaders(input: RequestHeaders): Headers {
  const incoming = new Headers(input), outgoing = new Headers();
  for (const name of ["cookie", "authorization"]) { const value = incoming.get(name); if (value) outgoing.set(name, value); }
  return outgoing;
}
async function pmGet(path: string, headers: RequestHeaders): Promise<unknown> {
  let response: Response;
  try { response = await fetch(pmUrl(path), { headers: authHeaders(headers), redirect: "error", signal: AbortSignal.timeout(30000) }); }
  catch { throw new ObservationError(503, "PM core observation is unavailable."); }
  if (!response.ok) throw new ObservationError([401, 403, 404].includes(response.status) ? response.status : 503, "PM core access or observation failed.");
  const limit = 64 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit) throw new ObservationError(503, "PM core response exceeds the observation limit.");
  const reader = response.body?.getReader();
  if (!reader) throw new ObservationError(503, "PM core response is empty.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > limit) { await reader.cancel(); throw new ObservationError(503, "PM core response exceeds the observation limit."); }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  } catch (error) { if (error instanceof ObservationError) throw error; throw new ObservationError(503, "PM core response is invalid or interrupted."); }
}
async function projects(scope: AgentScope, headers: RequestHeaders): Promise<ProjectScope[]> {
  if (scope.projectId) return [{ workspaceId: scope.workspaceId, projectId: scope.projectId }];
  const parsed = catalogSchema.safeParse(await pmGet("/api/v1/agent-contexts", headers));
  if (!parsed.success) throw new ObservationError(503, "PM context catalog is invalid.");
  const workspace = parsed.data.workspaces.find(item => item.id === scope.workspaceId);
  if (!workspace) throw new ObservationError(403, "PM workspace is not accessible.");
  return workspace.projects.map(item => ({ workspaceId: scope.workspaceId, projectId: item.id }));
}
function persist(scope: ProjectScope, data: z.infer<typeof sourceSchema>, createdProject: boolean): PmCoreObservation {
  if (data.files.some(file => file.projectId !== scope.projectId) || new Set(data.files.map(file => file.path)).size !== data.files.length)
    throw new ObservationError(503, "PM core response has conflicting file identities.");
  const observation: PmCoreObservation = data.complete ? { status: "active" } : { status: "incomplete", error: data.error ?? "PM core enumeration is incomplete." };
  transaction(() => {
    const db = getDatabase(), ns = snapshotNs(scope), key = scopeKey(scope);
    const initialized = readRecord<boolean>(stateNs, `baseline:${key}`) === true;
    const previous = new Map<string, Snapshot>(db.prepare("SELECT key,value FROM records WHERE namespace = ?").all(ns).map(row => [String(row.key), JSON.parse(String(row.value)) as Snapshot]));
    const firstCreationProof = createdProject && readRecord<boolean>(stateNs, `created:${key}`) !== true;
    const seen = new Set<string>();
    const record = (before: Snapshot | null, after: Snapshot | null) => {
      const current = after ?? before!;
      const change: PmCoreChange = { id: randomUUID(), ...scope, entityId: current.entityId, path: current.path,
        kind: before === null ? "added" : after === null ? "deleted" : "modified", observedAt: new Date().toISOString(),
        beforeHash: before?.hash ?? null, afterHash: after?.hash ?? null, before: before?.content ?? null, after: after?.content ?? null,
        source: "file_observation" };
      writeRecord(changesNs(scope), change.id, change);
    };
    if (firstCreationProof) {
      for (const before of previous.values()) record(null, before);
      writeRecord(stateNs, `created:${key}`, true);
      writeRecord(stateNs, `baseline:${key}`, true);
    }
    for (const file of data.files) {
      const after: Snapshot = { path: file.path, entityId: file.entityId, hash: digest(file.content), content: file.content };
      const before = previous.get(file.path) ?? null;
      seen.add(file.path);
      if ((before && before.hash !== after.hash) || ((initialized || firstCreationProof) && !before)) record(before, after);
      writeRecord(ns, file.path, after);
    }
    if (data.complete) {
      for (const [path, before] of previous) if (!seen.has(path)) { record(before, null); deleteRecord(ns, path); }
      writeRecord(stateNs, `baseline:${key}`, true);
    }
    writeRecord(stateNs, key, observation);
  });
  return observation;
}
const pending = new Map<string, Promise<PmCoreObservation>>();
function observeProject(scope: ProjectScope, headers: RequestHeaders, createdProject = false): Promise<PmCoreObservation> {
  const key = scopeKey(scope), prior = pending.get(key);
  const operation = (async () => {
    if (prior) await prior.catch(() => undefined);
    try {
      const endpoint = `/api/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/agent-tools/core-files?projectId=${encodeURIComponent(scope.projectId)}`;
      const parsed = sourceSchema.safeParse(await pmGet(endpoint, headers));
      if (!parsed.success) throw new ObservationError(503, "PM core enumeration is invalid or exceeds its limit.");
      return persist(scope, parsed.data, createdProject);
    } catch (error) {
      const failure = error instanceof ObservationError ? error : new ObservationError(503, "PM core observation failed.");
      if (failure.status >= 500) writeRecord(stateNs, key, { status: "failed", error: failure.message } satisfies PmCoreObservation);
      throw failure;
    }
  })();
  pending.set(key, operation);
  return operation.finally(() => { if (pending.get(key) === operation) pending.delete(key); });
}

// Request credentials stay in memory only, and are discarded after the short active window.
const active = new Map<string, { timer: NodeJS.Timeout; expires: number; headers: Headers }>();
function activate(scope: ProjectScope, headers: RequestHeaders): void {
  const key = scopeKey(scope), existing = active.get(key);
  if (existing) { existing.headers = authHeaders(headers); existing.expires = Date.now() + 120_000; return; }
  const entry = { headers: authHeaders(headers), expires: Date.now() + 120_000, timer: undefined as unknown as NodeJS.Timeout };
  entry.timer = setInterval(() => {
    if (Date.now() >= entry.expires) {
      clearInterval(entry.timer); active.delete(key);
      const last = readRecord<PmCoreObservation>(stateNs, key);
      if (last?.status === "active") writeRecord(stateNs, key, { status: "expired", error: "Observation credentials expired; refresh to resume." } satisfies PmCoreObservation);
      return;
    }
    void observeProject(scope, entry.headers).catch(error => {
      if (active.get(key) === entry && error instanceof ObservationError && error.status < 500) {
        clearInterval(entry.timer); active.delete(key);
        writeRecord(stateNs, key, { status: "expired", error: "PM access expired; authenticate and refresh to resume." } satisfies PmCoreObservation);
      }
    });
  }, 3000);
  entry.timer.unref(); active.set(key, entry);
}
async function scanScope(scope: AgentScope, headers: RequestHeaders, createdProjectId?: string): Promise<{ selected: ProjectScope[]; observation: PmCoreObservation }> {
  const selected = await projects(scope, headers);
  const results = await Promise.all(selected.map(async item => {
    const result = await observeProject(item, headers, item.projectId === createdProjectId);
    if (scope.projectId !== null) activate(item, headers);
    return result;
  }));
  let observation: PmCoreObservation = results.find(item => item.status === "incomplete" || item.status === "failed") ?? { status: selected.length ? "active" : "idle" };
  if (scope.projectId === null) {
    const key = `workspace-projects:${scope.workspaceId}`;
    const previous = readRecord<string[]>(stateNs, key) ?? [];
    const current = new Set(selected.map(item => item.projectId));
    for (const projectId of previous) {
      if (current.has(projectId)) continue;
      const item = { workspaceId: scope.workspaceId, projectId };
      try {
        const result = await observeProject(item, headers);
        selected.push(item);
        if (scope.projectId !== null) activate(item, headers);
        if (result.status === "incomplete" || result.status === "failed") observation = result;
      } catch {
        // An unavailable or newly forbidden project is not proof of deletion.
        observation = { status: "incomplete", error: "A previously observed project cannot currently be rechecked." };
      }
    }
    writeRecord(stateNs, key, [...new Set([...previous, ...current])]);
  }
  return { selected, observation };
}
const activeWorkspaces = new Map<string, { timer: NodeJS.Timeout; expires: number; headers: Headers; inFlight: Promise<void> | null }>();
function activateWorkspace(scope: AgentScope, headers: RequestHeaders): void {
  if (scope.projectId !== null) return;
  const key = scope.workspaceId, existing = activeWorkspaces.get(key);
  if (existing) { existing.headers = authHeaders(headers); existing.expires = Date.now() + 120_000; return; }
  const entry = { headers: authHeaders(headers), expires: Date.now() + 120_000, timer: undefined as unknown as NodeJS.Timeout, inFlight: null as Promise<void> | null };
  entry.timer = setInterval(() => {
    if (entry.inFlight) return;
    if (Date.now() >= entry.expires) { clearInterval(entry.timer); activeWorkspaces.delete(key); return; }
    entry.inFlight = scanScope(scope, entry.headers).then(() => undefined).catch(error => {
      if (error instanceof ObservationError && error.status < 500) { clearInterval(entry.timer); activeWorkspaces.delete(key); }
    }).finally(() => { entry.inFlight = null; });
  }, 3000);
  entry.timer.unref(); activeWorkspaces.set(key, entry);
}
/** Start/refresh scans require the current PM session; no credential is stored across restart. */
export async function observePmCoreChanges(scope: AgentScope, headers: RequestHeaders, correlation?: { operationId: string; createdProjectId?: string }): Promise<PmCoreObservation> {
  const createdProjectId = correlation?.createdProjectId;
  if (createdProjectId !== undefined && !/^PRJ-\d+$/.test(createdProjectId)) throw new ObservationError(400, "Invalid created project ID.");
  const parsed = scopeSchema.parse(scope);
  const result = await scanScope(parsed, headers, createdProjectId);
  activateWorkspace(parsed, headers);
  return result.observation;
}
export async function stopPmCoreChanges(): Promise<void> {
  for (const item of active.values()) clearInterval(item.timer);
  const workspaces = [...activeWorkspaces.values()];
  for (const item of workspaces) clearInterval(item.timer);
  active.clear(); activeWorkspaces.clear();
  await Promise.allSettled([...pending.values(), ...workspaces.flatMap(item => item.inFlight ? [item.inFlight] : [])]);
}

async function page(scope: AgentScope, headers: RequestHeaders, after: string | null): Promise<PmCoreChangesPage> {
  const { selected, observation } = await scanScope(scope, headers);
  activateWorkspace(scope, headers);
  if (!selected.length) return { items: [], nextCursor: null, observation };
  const cursor = after === null ? 0 : Number(after);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || (after !== null && !/^(0|[1-9]\d*)$/.test(after))) throw new ObservationError(400, "Invalid core changes cursor.");
  const namespaces = selected.map(changesNs), placeholders = namespaces.map(() => "?").join(",");
  const rows = getDatabase().prepare(`SELECT rowid,value FROM records WHERE namespace IN (${placeholders}) AND rowid > ? ORDER BY rowid LIMIT 51`).all(...namespaces, cursor);
  const items = rows.slice(0, 50).map(row => {
    const change = JSON.parse(String(row.value)) as PmCoreChange;
    const max = 256 * 1024;
    return { ...change,
      before: change.before === null ? null : change.before.slice(0, max),
      after: change.after === null ? null : change.after.slice(0, max),
      ...(change.before !== null && change.before.length > max ? { beforeTruncated: true } : {}),
      ...(change.after !== null && change.after.length > max ? { afterTruncated: true } : {}) };
  });
  return { items, nextCursor: rows.length > 50 ? String(rows[49]!.rowid) : null, observation };
}

export const pmCoreChangesRoutes = new Hono();
pmCoreChangesRoutes.onError((error, c) => {
  if (error instanceof ObservationError) {
    if (error.status === 503) return c.json({ items: [], nextCursor: null, observation: { status: "failed", error: error.message } });
    return c.json({ error: error.message }, error.status as 400 | 401 | 403 | 404);
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: "Invalid core observation request." }, 400);
  return c.json({ error: "Core observation failed." }, 503);
});
pmCoreChangesRoutes.get("/pm-core-changes", async c => {
  const scope = scopeSchema.parse({ workspaceId: c.req.query("workspaceId"), projectId: c.req.query("projectId") || null });
  c.header("Cache-Control", "private, no-store");
  return c.json(await page(scope, c.req.raw.headers, c.req.query("after") ?? null));
});
pmCoreChangesRoutes.get("/pm-core-changes/:id", async c => {
  const scope = scopeSchema.parse({ workspaceId: c.req.query("workspaceId"), projectId: c.req.query("projectId") || null });
  const id = z.uuid().parse(c.req.param("id"));
  const { selected } = await scanScope(scope, c.req.raw.headers);
  c.header("Cache-Control", "private, no-store");
  for (const item of selected) {
    const change = readRecord<PmCoreChange>(changesNs(item), id);
    if (change) return c.json({ item: change });
  }
  return c.json({ error: "Core change not found or inaccessible." }, 404);
});
pmCoreChangesRoutes.post("/pm-core-changes/refresh", async c => {
  const scope = scopeSchema.parse(await c.req.json());
  c.header("Cache-Control", "private, no-store");
  return c.json(await page(scope, c.req.raw.headers, null));
});
