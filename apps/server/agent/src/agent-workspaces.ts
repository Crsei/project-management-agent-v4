import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { executionSelectionSchema, type AgentWorkspace, type ExecutionEnvironment, type ExecutionSelection } from "../../../../packages/agent-contracts/src/execution.ts";
import { assertPrivatePath, makePrivatePath } from "../../../../packages/pm-core/private-path.ts";
import { assertNoWindowsReparsePath } from "../../../../packages/pm-core/windows-reparse.ts";
import { DurableError } from "./durable/errors.ts";
import { listRecords, readRecord, transaction, writeRecord } from "./durable/store.ts";
import { dataDirectory } from "./paths.ts";

const workspaceNamespace = "agent:workspaces:v1";
const scratchNamespace = "agent:scratch:v1";
const absolutePath = z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && !value.includes("\0"), "An absolute server directory is required.");
const displayName = z.string().trim().min(1).max(200);
const openSchema = z.strictObject({ path: absolutePath, name: displayName.optional() });
const updateSchema = z.strictObject({ expectedRevision: z.number().int().positive(), name: displayName.optional(), archived: z.boolean().optional() }).refine(value => value.name !== undefined || value.archived !== undefined, "Specify a name or archive state.");
const sessionIdentifier = z.string().min(1).max(256).refine(value => !value.includes("\0"));

type DirectoryIdentity = { device: string; inode: string; birthtime: string };
type WorkspaceRecord = {
  id: string;
  name: string;
  path: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  directoryIdentity: DirectoryIdentity;
};
type ScratchRecord = { sessionId: string; directoryIdentity: DirectoryIdentity; parentIdentity: DirectoryIdentity };
export type AgentWorkspaceExecution = { path: string; environment: ExecutionEnvironment };
export type AgentDirectoryListing = { path: string | null; parentPath: string | null; roots: string[]; directories: { name: string; path: string }[] };

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new DurableError(400, "invalid_workspace_request", "The Agent directory request is invalid.");
  return result.data;
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.birthtime === right.birthtime;
}

function identity(stat: BigIntStats): DirectoryIdentity {
  return { device: String(stat.dev), inode: String(stat.ino), birthtime: String(stat.birthtimeNs) };
}

function inspectDirectory(input: string): { path: string; identity: DirectoryIdentity } {
  try {
    const canonical = realpathSync(input);
    const before = statSync(canonical, { bigint: true });
    if (!before.isDirectory()) throw new DurableError(400, "not_directory", "Choose an existing server directory.");
    const after = statSync(canonical, { bigint: true });
    if (realpathSync(input) !== canonical || !after.isDirectory() || !sameDirectory(identity(before), identity(after))) {
      throw new DurableError(412, "directory_changed", "The directory identity changed; no replacement directory was adopted.");
    }
    return { path: canonical, identity: identity(after) };
  } catch (error) {
    if (error instanceof DurableError) throw error;
    throw new DurableError(412, "directory_unavailable", "The directory is missing or inaccessible.");
  }
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Canonical roots are evaluated from public configuration, never a PM catalog or cwd. */
function allowedRoots(): string[] {
  const configured = process.env.AGENT_WORKSPACE_ALLOWED_ROOTS;
  let inputs: string[];
  if (configured === undefined) inputs = [homedir()];
  else {
    let decoded: unknown;
    try { decoded = JSON.parse(configured); }
    catch { throw new DurableError(503, "workspace_roots_invalid", "AGENT_WORKSPACE_ALLOWED_ROOTS must be a JSON array of absolute server directories."); }
    const result = z.array(absolutePath).safeParse(decoded);
    if (!result.success) throw new DurableError(503, "workspace_roots_invalid", "AGENT_WORKSPACE_ALLOWED_ROOTS must be a JSON array of absolute server directories.");
    inputs = result.data;
  }
  const roots = new Set<string>();
  for (const input of inputs) {
    try { roots.add(inspectDirectory(input).path); }
    catch (error) { if (!(error instanceof DurableError)) throw error; }
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
}

function requireAllowed(directory: string, roots = allowedRoots()): void {
  if (!roots.some(root => contains(root, directory))) throw new DurableError(403, "directory_not_allowed", "The directory is outside the configured Agent workspace roots. Choose an allowed root or have the service operator configure AGENT_WORKSPACE_ALLOWED_ROOTS; choosing a folder does not grant access.");
}

function verifiedWorkspace(record: WorkspaceRecord): string {
  const directory = inspectDirectory(record.path);
  requireAllowed(directory.path);
  if (directory.path !== record.path || !record.directoryIdentity || !sameDirectory(record.directoryIdentity, directory.identity)) {
    throw new DurableError(412, "workspace_directory_changed", "The registered directory was replaced or redirected. Its immutable binding cannot be reused.");
  }
  return directory.path;
}

function publicWorkspace(record: WorkspaceRecord): AgentWorkspace {
  let availability: Pick<AgentWorkspace, "status" | "reason"> = { status: "available" };
  try { verifiedWorkspace(record); }
  catch (error) {
    if (!(error instanceof DurableError)) throw error;
    availability = { status: "unavailable", reason: error.message };
  }
  return {
    id: record.id, name: record.name, path: record.path, revision: record.revision,
    createdAt: record.createdAt, updatedAt: record.updatedAt, archivedAt: record.archivedAt,
    ...availability,
  };
}

export function getAgentWorkspace(id: string): AgentWorkspace | null {
  const record = readRecord<WorkspaceRecord>(workspaceNamespace, id);
  return record ? publicWorkspace(record) : null;
}

export function listAgentWorkspaces(): AgentWorkspace[] {
  return listRecords<WorkspaceRecord>(workspaceNamespace).map(publicWorkspace);
}

/** Opening aliases reuses immutable canonical identity; reopening only changes visibility metadata. */
export function openAgentWorkspace(input: { path: string; name?: string }): AgentWorkspace {
  const value = parse(openSchema, input);
  return transaction(() => {
    const directory = inspectDirectory(value.path);
    requireAllowed(directory.path);
    const records = listRecords<WorkspaceRecord>(workspaceNamespace);
    const registeredInput = records.find(record => record.path === path.resolve(value.path));
    if (registeredInput) verifiedWorkspace(registeredInput);
    const existing = records.find(record => record.path === directory.path);
    if (existing) {
      verifiedWorkspace(existing);
      if (existing.archivedAt !== null) {
        existing.archivedAt = null;
        existing.revision += 1;
        existing.updatedAt = new Date().toISOString();
        writeRecord(workspaceNamespace, existing.id, existing);
      }
      return publicWorkspace(existing);
    }
    const now = new Date().toISOString();
    const record: WorkspaceRecord = {
      id: randomUUID(), name: value.name ?? (path.basename(directory.path) || directory.path).slice(0, 200), path: directory.path,
      revision: 1, createdAt: now, updatedAt: now, archivedAt: null, directoryIdentity: directory.identity,
    };
    verifiedWorkspace(record);
    writeRecord(workspaceNamespace, record.id, record);
    return publicWorkspace(record);
  });
}

export function updateAgentWorkspace(id: string, input: { expectedRevision: number; name?: string; archived?: boolean }): AgentWorkspace {
  const value = parse(updateSchema, input);
  return transaction(() => {
    const record = readRecord<WorkspaceRecord>(workspaceNamespace, id);
    if (!record) throw new DurableError(404, "agent_workspace_not_found", "The Agent workspace does not exist.");
    if (record.revision !== value.expectedRevision) throw new DurableError(409, "workspace_revision_conflict", "The Agent workspace metadata changed. Refresh before editing it.");
    if (value.archived === false) verifiedWorkspace(record);
    const changed = value.name !== undefined && value.name !== record.name || value.archived !== undefined && value.archived !== (record.archivedAt !== null);
    if (changed) {
      const now = new Date().toISOString();
      if (value.name !== undefined) record.name = value.name;
      if (value.archived !== undefined) record.archivedAt = value.archived ? record.archivedAt ?? now : null;
      record.updatedAt = now;
      record.revision += 1;
      writeRecord(workspaceNamespace, id, record);
    }
    return publicWorkspace(record);
  });
}

export function browseAgentDirectories(input?: string): AgentDirectoryListing {
  const roots = allowedRoots();
  if (input === undefined) return { path: null, parentPath: null, roots, directories: [] };
  const directory = inspectDirectory(parse(absolutePath, input));
  requireAllowed(directory.path, roots);
  const directories: AgentDirectoryListing["directories"] = [];
  try {
    for (const entry of readdirSync(directory.path, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try {
        const child = inspectDirectory(path.join(directory.path, entry.name));
        requireAllowed(child.path, roots);
        directories.push({ name: entry.name, path: child.path });
      } catch (error) { if (!(error instanceof DurableError)) throw error; }
    }
  } catch (error) {
    if (error instanceof DurableError) throw error;
    throw new DurableError(412, "directory_unavailable", "The directory cannot be browsed.");
  }
  const after = inspectDirectory(directory.path);
  if (!sameDirectory(directory.identity, after.identity)) throw new DurableError(412, "directory_changed", "The directory changed while it was being browsed.");
  const parent = path.dirname(directory.path);
  return {
    path: directory.path, parentPath: parent !== directory.path && roots.some(root => contains(root, parent)) ? parent : null,
    roots, directories: directories.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/** Only newly allocated paths may have their permissions established, never existing scratch. */
function privateDirectory(directory: string, created = false): DirectoryIdentity {
  try {
    const before = lstatSync(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || process.platform !== "win32" && typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())) {
      throw new DurableError(412, "chat_scratch_unavailable", "Private chat scratch identity or permissions are invalid.");
    }
    assertNoWindowsReparsePath(directory, before);
    if (created) makePrivatePath(directory);
    else assertPrivatePath(directory);
    const after = lstatSync(directory, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !sameDirectory(identity(before), identity(after))
      || process.platform !== "win32" && ((Number(after.mode) & 0o077) !== 0 || typeof process.getuid === "function" && after.uid !== BigInt(process.getuid()))) {
      throw new DurableError(412, "chat_scratch_unavailable", "Private chat scratch identity or permissions are invalid.");
    }
    assertNoWindowsReparsePath(directory, after);
    return identity(after);
  } catch (error) {
    if (error instanceof DurableError) throw error;
    throw new DurableError(412, "chat_scratch_unavailable", "Private chat scratch is missing, inaccessible or not private; no replacement was created.");
  }
}

function chatScratch(sessionId: string): string {
  parse(sessionIdentifier, sessionId);
  return transaction(() => {
    const existing = readRecord<ScratchRecord>(scratchNamespace, sessionId);
    // Never trust a persisted absolute path: restored stores remain inside their own dataDirectory.
    const parent = path.join(realpathSync(dataDirectory()), "chat-scratch");
    let parentCreated = false;
    if (!existing) {
      try { mkdirSync(parent, { mode: 0o700 }); parentCreated = true; }
      catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; }
    }
    const parentIdentity = privateDirectory(parent, parentCreated);
    const directory = path.join(parent, createHash("sha256").update(sessionId).digest("hex"));
    if (existing) {
      if (existing.sessionId !== sessionId || !sameDirectory(existing.parentIdentity, parentIdentity) || !sameDirectory(existing.directoryIdentity, privateDirectory(directory))) {
        throw new DurableError(412, "chat_scratch_changed", "Private chat scratch was replaced; the original execution cannot be resumed.");
      }
    } else {
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch { throw new DurableError(412, "chat_scratch_unavailable", "Private chat scratch cannot be allocated without adopting an existing directory."); }
      writeRecord<ScratchRecord>(scratchNamespace, sessionId, { sessionId, parentIdentity, directoryIdentity: privateDirectory(directory, true) });
    }
    if (!sameDirectory(parentIdentity, privateDirectory(parent))) throw new DurableError(412, "chat_scratch_changed", "Private chat scratch changed during resolution.");
    return directory;
  });
}

/** PM-independent authority for every ordinary Provider/Files/Git/PTY execution directory. */
export function resolveAgentWorkspaceExecution(selection: ExecutionSelection, sessionId?: string): AgentWorkspaceExecution {
  const value = parse(executionSelectionSchema, selection);
  if (value.agentWorkspaceId === null) {
    if (sessionId === undefined) throw new DurableError(400, "chat_session_required", "Chat-only scratch requires an explicit session identity.");
    return {
      path: chatScratch(sessionId),
      environment: { version: 2, hostId: "local", agentWorkspaceId: null, agentWorkspaceName: null, agentWorkspaceRevision: null, sourcePath: null, executionPath: null, worktree: null, frozen: false },
    };
  }
  const record = readRecord<WorkspaceRecord>(workspaceNamespace, value.agentWorkspaceId);
  if (!record) throw new DurableError(404, "agent_workspace_not_found", "The Agent workspace does not exist.");
  // Revisions govern editable display metadata, not the immutable directory binding of existing Sessions.
  if (value.agentWorkspaceRevision! > record.revision) throw new DurableError(409, "workspace_revision_conflict", "The selected Agent workspace revision does not exist.");
  const executionPath = verifiedWorkspace(record);
  return {
    path: executionPath,
    environment: { version: 2, hostId: "local", agentWorkspaceId: record.id, agentWorkspaceName: record.name, agentWorkspaceRevision: value.agentWorkspaceRevision, sourcePath: record.path, executionPath, worktree: null, frozen: false },
  };
}
