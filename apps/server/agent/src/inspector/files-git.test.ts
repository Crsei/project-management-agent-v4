import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type {
  GitDiffResponse,
  GitStatusResponse,
  InspectorFileResponse,
  InspectorTreeResponse,
} from "@agent-workspace/contracts/inspector";
import type { AgentWorkspace } from "@agent-workspace/contracts/chat";

const projectDir = await mkdtemp(path.join(tmpdir(), "inspector-project-"));
const dataDir = await mkdtemp(path.join(tmpdir(), "inspector-data-"));
const repoDir = await mkdtemp(path.join(tmpdir(), "inspector-repo-"));
const outsideDir = await mkdtemp(path.join(tmpdir(), "inspector-outside-"));
const original = {
  data: process.env.AGENT_WORKSPACE_DATA_DIR, roots: process.env.AGENT_WORKSPACE_ALLOWED_ROOTS,
  pm: process.env.PM_API_URL, access: process.env.AGENT_WORKSPACE_ACCESS_TOKEN,
  ceiling: process.env.GIT_CEILING_DIRECTORIES,
};
process.env.AGENT_WORKSPACE_DATA_DIR = dataDir;
process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([tmpdir()]);
delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
process.env.GIT_CEILING_DIRECTORIES = tmpdir();

// These imports must follow fixture environment setup: the durable store and
// execution modules snapshot data-directory configuration during module loading.
const { inspectorRoutes } = await import("./index.ts");
const { accessGuard } = await import("../access.ts");
const { ensureThread, freezeThreadExecution } = await import("../durable/threads.ts");
const { closeStore } = await import("../durable/store.ts");
const { openAgentWorkspace, resolveAgentWorkspaceExecution, updateAgentWorkspace } = await import("../agent-workspaces.ts");
const app = new Hono().use("/api/*", accessGuard).route("/api", inspectorRoutes);
const fixtures = new Map<string, { workspace: AgentWorkspace; threadId: string }>();
let currentDirectory = projectDir;
let pmServer: Server;
let pmRequests = 0;

function directoryFixture(directory: string) {
  let fixture = fixtures.get(directory);
  if (!fixture) {
    const workspace = openAgentWorkspace({ path: directory });
    const threadId = `fixture:${workspace.id}`;
    const selection = { version: 2 as const, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
    ensureThread(threadId, undefined, selection);
    fixture = { workspace, threadId };
    fixtures.set(directory, fixture);
  }
  return fixture;
}

async function getJson<T>(
  url: string,
  directory = currentDirectory,
): Promise<{ status: number; body: T }> {
  const scoped = new URL(url, "http://localhost");
  if (!scoped.searchParams.has("threadId"))
    scoped.searchParams.set("threadId", directoryFixture(directory).threadId);
  const response = await app.request(scoped.toString(), { headers: { host: "localhost" } });
  return { status: response.status, body: (await response.json()) as T };
}

function runGit(cwd: string, args: string[]): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(stderr.trim() || error.message));
      return;
    }
    resolve(stdout);
  });
  return promise;
}

async function selectDirectory(directory: string): Promise<void> {
  currentDirectory = directory;
  directoryFixture(directory);
}

before(async () => {
  pmServer = createServer((_request, response) => {
    pmRequests++;
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "PM is deliberately offline" }));
  });
  const listening = Promise.withResolvers<void>();
  pmServer.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  process.env.PM_API_URL = `http://127.0.0.1:${(pmServer.address() as AddressInfo).port}`;
  await mkdir(path.join(projectDir, "src"), { recursive: true });
  await mkdir(path.join(projectDir, "docs"), { recursive: true });
  await mkdir(path.join(projectDir, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(projectDir, ".git"), { recursive: true });
  await writeFile(path.join(projectDir, "src", "index.ts"), "export const value = 1;\n");
  await writeFile(path.join(projectDir, "docs", "readme.md"), "# docs\n");
  await writeFile(path.join(projectDir, "a.txt"), "alpha\n");
  await writeFile(path.join(projectDir, ".hidden"), "hidden\n");
  await writeFile(path.join(projectDir, "z.txt"), "zed\n");
  await writeFile(path.join(projectDir, "big.txt"), "x".repeat(300 * 1024));
  await writeFile(path.join(projectDir, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
  await symlink(outsideDir, path.join(projectDir, "escape"));

  await runGit(repoDir, ["init", "-q", "-b", "main"]);
  await runGit(repoDir, ["config", "user.email", "inspector@example.com"]);
  await runGit(repoDir, ["config", "user.name", "Inspector Test"]);
  await writeFile(path.join(repoDir, "tracked.txt"), "hello\n");
  await writeFile(path.join(repoDir, "kept.txt"), "keep\n");
  await writeFile(path.join(repoDir, "remove.txt"), "gone\n");
  await runGit(repoDir, ["add", "."]);
  await runGit(repoDir, ["commit", "-qm", "init"]);

  await writeFile(path.join(repoDir, "tracked.txt"), "hello\nchanged\n");
  await rm(path.join(repoDir, "remove.txt"));
  await writeFile(path.join(repoDir, "staged.txt"), "staged content\n");
  await runGit(repoDir, ["add", "staged.txt"]);
  await runGit(repoDir, ["mv", "kept.txt", "renamed.txt"]);
  await writeFile(path.join(repoDir, "notes.md"), "untracked content\n");
});

after(async () => {
  assert.equal(pmRequests, 0, "ordinary inspection never calls PM");
  closeStore();
  const closing = Promise.withResolvers<void>();
  pmServer.close((error) => error ? closing.reject(error) : closing.resolve());
  await closing.promise;
  for (const [key, value] of [
    ["AGENT_WORKSPACE_DATA_DIR", original.data], ["AGENT_WORKSPACE_ALLOWED_ROOTS", original.roots],
    ["PM_API_URL", original.pm], ["AGENT_WORKSPACE_ACCESS_TOKEN", original.access],
    ["GIT_CEILING_DIRECTORIES", original.ceiling],
  ] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await Promise.all(
    [projectDir, dataDir, repoDir, outsideDir].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("lists the project root with directories first and ignored folders removed", async () => {
  const { status, body } = await getJson<InspectorTreeResponse>("/api/inspector/files?path=");
  assert.equal(status, 200);
  assert.equal(body.root, projectDir);
  assert.equal(body.path, "");
  assert.equal(body.truncated, false);
  assert.deepEqual(
    body.entries.map((entry) => `${entry.kind}:${entry.name}`),
    [
      "directory:docs",
      "directory:src",
      "file:.hidden",
      "file:a.txt",
      "file:big.txt",
      "file:bin.dat",
      "file:z.txt",
    ],
  );
  const big = body.entries.find((entry) => entry.name === "big.txt");
  assert.equal(big?.size, 300 * 1024);
  const docs = body.entries.find((entry) => entry.name === "docs");
  assert.equal(docs?.size, null);
});

test("lists a nested directory with relative paths", async () => {
  const { status, body } = await getJson<InspectorTreeResponse>("/api/inspector/files?path=src");
  assert.equal(status, 200);
  assert.equal(body.path, "src");
  assert.deepEqual(body.entries, [
    { name: "index.ts", path: "src/index.ts", kind: "file", size: 24 },
  ]);
});

test("rejects paths that do not exist or are not directories", async () => {
  const missing = await getJson<{ error: string; code: string }>(
    "/api/inspector/files?path=missing-dir",
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "not_found");

  const notDirectory = await getJson<{ error: string; code: string }>(
    "/api/inspector/files?path=a.txt",
  );
  assert.equal(notDirectory.status, 400);
  assert.equal(notDirectory.body.code, "not_a_directory");

  const traversal = await getJson<{ error: string; code: string }>(
    "/api/inspector/files?path=../../etc/passwd",
  );
  assert.equal(traversal.status, 400);
  assert.equal(traversal.body.code, "invalid_path");
});

test("reads text files and reports truncation", async () => {
  const text = await getJson<InspectorFileResponse>("/api/inspector/file?path=src/index.ts");
  assert.equal(text.status, 200);
  assert.equal(text.body.path, "src/index.ts");
  assert.equal(text.body.content, "export const value = 1;\n");
  assert.equal(text.body.truncated, false);

  const big = await getJson<InspectorFileResponse>("/api/inspector/file?path=big.txt");
  assert.equal(big.status, 200);
  assert.equal(big.body.size, 300 * 1024);
  assert.equal(big.body.truncated, true);
  assert.equal(Buffer.byteLength(big.body.content, "utf8"), 256 * 1024);
});

test("rejects binary files, directories, missing paths and traversal", async () => {
  const binary = await getJson<{ error: string; code: string }>("/api/inspector/file?path=bin.dat");
  assert.equal(binary.status, 415);
  assert.equal(binary.body.code, "binary_file");

  const directory = await getJson<{ error: string; code: string }>("/api/inspector/file?path=src");
  assert.equal(directory.status, 400);
  assert.equal(directory.body.code, "not_a_file");

  const missing = await getJson<{ error: string; code: string }>(
    "/api/inspector/file?path=src/missing.ts",
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "not_found");

  const traversal = await getJson<{ error: string; code: string }>(
    "/api/inspector/file?path=../../etc/passwd",
  );
  assert.equal(traversal.status, 400);
  assert.equal(traversal.body.code, "invalid_path");
});

test("reports git status with staged and unstaged flags", async () => {
  await selectDirectory(repoDir);
  const { status, body } = await getJson<GitStatusResponse>("/api/inspector/git");
  assert.equal(status, 200);
  assert.equal(body.repo, true);
  assert.equal(body.branch, "main");
  assert.equal(body.ahead, 0);
  assert.equal(body.behind, 0);
  assert.equal(body.truncated, false);

  const byPath = new Map(body.files.map((file) => [file.path, file]));
  assert.deepEqual(byPath.get("tracked.txt"), {
    path: "tracked.txt",
    status: "modified",
    staged: false,
    unstaged: true,
  });
  assert.deepEqual(byPath.get("staged.txt"), {
    path: "staged.txt",
    status: "added",
    staged: true,
    unstaged: false,
  });
  assert.deepEqual(byPath.get("remove.txt"), {
    path: "remove.txt",
    status: "deleted",
    staged: false,
    unstaged: true,
  });
  assert.deepEqual(byPath.get("renamed.txt"), {
    path: "renamed.txt",
    oldPath: "kept.txt",
    status: "renamed",
    staged: true,
    unstaged: false,
  });
  assert.deepEqual(byPath.get("notes.md"), {
    path: "notes.md",
    status: "untracked",
    staged: false,
    unstaged: true,
  });
});

test("returns staged and worktree diffs", async () => {
  await selectDirectory(repoDir);

  const staged = await getJson<GitDiffResponse>("/api/inspector/git/diff?path=staged.txt&staged=1");
  assert.equal(staged.status, 200);
  assert.equal(staged.body.staged, true);
  assert.equal(staged.body.untracked, false);
  assert.match(staged.body.patch, /\+staged content/);

  const worktree = await getJson<GitDiffResponse>("/api/inspector/git/diff?path=tracked.txt");
  assert.equal(worktree.status, 200);
  assert.equal(worktree.body.staged, false);
  assert.equal(worktree.body.untracked, false);
  assert.match(worktree.body.patch, /\+changed/);

  const stagedWorktree = await getJson<GitDiffResponse>("/api/inspector/git/diff?path=staged.txt");
  assert.equal(stagedWorktree.status, 200);
  assert.equal(stagedWorktree.body.patch, "");
  assert.equal(stagedWorktree.body.untracked, false);
});

test("diffs untracked files against /dev/null", async () => {
  await selectDirectory(repoDir);
  const { status, body } = await getJson<GitDiffResponse>("/api/inspector/git/diff?path=notes.md");
  assert.equal(status, 200);
  assert.equal(body.untracked, true);
  assert.equal(body.staged, false);
  assert.match(body.patch, /--- \/dev\/null/);
  assert.match(body.patch, /\+untracked content/);
});

test("diffs staged renames and worktree deletions", async () => {
  await selectDirectory(repoDir);
  const renamed = await getJson<GitDiffResponse>(
    "/api/inspector/git/diff?path=renamed.txt&staged=true",
  );
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.staged, true);
  assert.match(renamed.body.patch, /\+keep/);

  const deleted = await getJson<GitDiffResponse>("/api/inspector/git/diff?path=remove.txt");
  assert.equal(deleted.body.untracked, false);
  assert.match(deleted.body.patch, /-gone/);
});

test("does not borrow a parent repository when a selected root is a repository subdirectory", async () => {
  const outer = await mkdtemp(path.join(tmpdir(), "inspector-outer-"));
  const inner = path.join(outer, "app");
  try {
    await mkdir(inner, { recursive: true });
    await runGit(outer, ["init"]);
    await runGit(outer, ["config", "user.email", "test@example.com"]);
    await runGit(outer, ["config", "user.name", "Test"]);
    await writeFile(path.join(inner, "inside.txt"), "inside\n");
    await writeFile(path.join(outer, "outside.txt"), "outside\n");

    await selectDirectory(inner);
    const status = await getJson<GitStatusResponse>("/api/inspector/git");
    assert.equal(status.status, 200);
    assert.equal(status.body.repo, false);
    assert.deepEqual(status.body.files, []);
    const diff = await getJson<GitDiffResponse>("/api/inspector/git/diff?path=inside.txt");
    assert.equal(diff.status, 409);
  } finally {
    await selectDirectory(repoDir);
    await rm(outer, { recursive: true, force: true });
  }
});

test("reports non-repositories", async () => {
  await selectDirectory(projectDir);
  const status = await getJson<GitStatusResponse>("/api/inspector/git");
  assert.equal(status.status, 200);
  assert.equal(status.body.repo, false);
  assert.deepEqual(status.body.files, []);

  const diff = await getJson<{ error: string; code: string }>("/api/inspector/git/diff?path=a.txt");
  assert.equal(diff.status, 409);
  assert.equal(diff.body.code, "not_a_repo");

  await selectDirectory(repoDir);
});

test("requires one explicit Session and rejects all client filesystem or PM binding parameters", async () => {
  const threadId = directoryFixture(projectDir).threadId;
  for (const endpoint of ["files", "file", "git", "git/diff"]) {
    for (const query of [
      "", "?threadId=", `?threadId=${threadId}&threadId=forged`,
      ...["workspaceId", "projectId", "rootId", "agentWorkspaceId", "cwd", "root"].map(
        key => `?threadId=${threadId}&${key}=${encodeURIComponent(outsideDir)}`,
      ),
    ]) {
      const response = await app.request(`/api/inspector/${endpoint}${query}`, { headers: { host: "localhost" } });
      assert.equal(response.status, 400, `${endpoint}${query}`);
    }
  }
  assert.equal(pmRequests, 0);
});

test("denies unknown and chat-only Sessions without allocating an inspectable scratch root", async () => {
  ensureThread("inspector-chat-only", undefined, { version: 2, agentWorkspaceId: null, agentWorkspaceRevision: null });
  for (const endpoint of ["files", "file", "git", "git/diff"]) {
    assert.equal((await getJson(`/api/inspector/${endpoint}?threadId=missing`)).status, 404);
    assert.equal((await getJson(`/api/inspector/${endpoint}?threadId=inspector-chat-only`)).status, 412);
  }
});

test("resolves simultaneous directory Sessions independently while PM is offline", async () => {
  const [first, second, repo, nonRepo] = await Promise.all([
    getJson<InspectorTreeResponse>("/api/inspector/files", projectDir),
    getJson<InspectorTreeResponse>("/api/inspector/files", repoDir),
    getJson<GitStatusResponse>("/api/inspector/git", repoDir),
    getJson<GitStatusResponse>("/api/inspector/git", projectDir),
  ]);
  assert.equal(first.body.root, projectDir);
  assert.equal(second.body.root, repoDir);
  assert.ok(!first.body.entries.some(entry => entry.name === "tracked.txt"));
  assert.ok(!second.body.entries.some(entry => entry.name === "a.txt"));
  assert.equal(repo.body.repo, true);
  assert.equal(nonRepo.body.repo, false);
  const [own, other] = await Promise.all([
    getJson<InspectorFileResponse>("/api/inspector/file?path=a.txt", projectDir),
    getJson("/api/inspector/file?path=a.txt", repoDir),
  ]);
  assert.equal(own.body.content, "alpha\n");
  assert.equal(other.status, 404);
  assert.equal(pmRequests, 0);
});

test("keeps same-origin, Agent access and MCP exclusion ahead of directory resolution", async () => {
  const url = `/api/inspector/files?threadId=${directoryFixture(projectDir).threadId}`;
  assert.equal((await app.request(url, { headers: { host: "localhost", origin: "https://evil.invalid" } })).status, 403);
  assert.equal((await app.request(url, { headers: { host: "localhost", authorization: "Bearer pm-mcp-access-v1.forged" } })).status, 401);
  const previousToken = process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  process.env.AGENT_WORKSPACE_ACCESS_TOKEN = "inspector-test-access-token-at-least-32-chars";
  try {
    assert.equal((await app.request(url, { headers: { host: "localhost" } })).status, 401);
    assert.equal((await app.request(url, { headers: { host: "localhost", authorization: `Bearer ${process.env.AGENT_WORKSPACE_ACCESS_TOKEN}` } })).status, 200);
  } finally {
    if (previousToken === undefined) delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
    else process.env.AGENT_WORKSPACE_ACCESS_TOKEN = previousToken;
  }
});

test("rejects a frozen Session path rebind instead of inspecting the new path", async () => {
  const workspace = directoryFixture(projectDir).workspace;
  const selection = { version: 2 as const, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
  ensureThread("inspector-rebound", undefined, selection);
  const { environment } = resolveAgentWorkspaceExecution(selection);
  freezeThreadExecution("inspector-rebound", { ...environment, executionPath: repoDir, frozen: true });
  for (const endpoint of ["files", "git"])
    assert.equal((await getJson(`/api/inspector/${endpoint}?threadId=inspector-rebound`)).status, 409);
});

test("future revisions reject and metadata rename does not rebind an existing Session", async () => {
  const fixture = directoryFixture(projectDir);
  const selection = { version: 2 as const, agentWorkspaceId: fixture.workspace.id, agentWorkspaceRevision: fixture.workspace.revision + 100 };
  ensureThread("inspector-future-revision", undefined, selection);
  assert.ok((await getJson("/api/inspector/files?threadId=inspector-future-revision")).status >= 400);
  updateAgentWorkspace(fixture.workspace.id, { expectedRevision: fixture.workspace.revision, name: "Renamed directory" });
  const unchanged = await getJson<InspectorTreeResponse>("/api/inspector/files", projectDir);
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.body.root, projectDir);
});

test("rejects same-path directory replacement and missing roots without fallback", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inspector-replacement-"));
  const moved = `${directory}-original`;
  try {
    const fixture = directoryFixture(directory);
    await rename(directory, moved);
    for (const endpoint of ["files", "git"])
      assert.ok((await getJson(`/api/inspector/${endpoint}?threadId=${fixture.threadId}`)).status >= 400);
    await mkdir(directory);
    await writeFile(path.join(directory, "replacement-secret"), "must not appear");
    for (const endpoint of ["files", "git"])
      assert.ok((await getJson(`/api/inspector/${endpoint}?threadId=${fixture.threadId}`)).status >= 400);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});

test("keeps duplicate relative filenames isolated by server-resolved Session directories", async () => {
  await writeFile(path.join(projectDir, "duplicate.txt"), "first-directory");
  await writeFile(path.join(repoDir, "duplicate.txt"), "second-directory");
  const first = await getJson<InspectorFileResponse>("/api/inspector/file?path=duplicate.txt", projectDir);
  const second = await getJson<InspectorFileResponse>("/api/inspector/file?path=duplicate.txt", repoDir);
  assert.equal(first.body.content, "first-directory");
  assert.equal(second.body.content, "second-directory");
});

test("denies symlinks outside the selected directory, including missing descendants", async () => {
  for (const endpoint of ["files", "file", "git/diff"]) {
    for (const target of ["escape", "escape/deleted.txt"])
      assert.equal((await getJson(`/api/inspector/${endpoint}?path=${target}`, projectDir)).status, 400);
  }
});

test("rejects an enclosing repository and treats pathspec magic literally in an independently selected repository", async () => {
  const outer = await mkdtemp(path.join(tmpdir(), "inspector-pathspec-"));
  const inner = path.join(outer, "app");
  try {
    await mkdir(inner);
    await runGit(outer, ["init", "-q"]);
    await runGit(outer, ["config", "user.email", "test@example.com"]);
    await runGit(outer, ["config", "user.name", "Test"]);
    await writeFile(path.join(outer, "outside.txt"), "private before\n");
    await writeFile(path.join(inner, "inside.txt"), "inside before\n");
    await runGit(outer, ["add", "."]);
    await runGit(outer, ["commit", "-qm", "init"]);
    await writeFile(path.join(outer, "outside.txt"), "private after\n");
    const status = await getJson<GitStatusResponse>("/api/inspector/git", inner);
    assert.equal(status.body.repo, false);
    const rejected = await getJson<{ code: string }>("/api/inspector/git/diff", inner);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, "not_a_repo");
    await runGit(inner, ["init", "-q"]);
    await runGit(inner, ["config", "user.email", "test@example.com"]);
    await runGit(inner, ["config", "user.name", "Test"]);
    await runGit(inner, ["add", "."]);
    await runGit(inner, ["commit", "-qm", "independent root"]);
    await writeFile(path.join(inner, "inside.txt"), "inside after\n");
    const independent = await getJson<GitStatusResponse>("/api/inspector/git", inner);
    assert.equal(independent.body.root, inner);
    assert.equal(independent.body.files[0]?.path, "inside.txt");
    const diff = await getJson<GitDiffResponse>(`/api/inspector/git/diff?path=${encodeURIComponent(":(top)inside.txt")}`, inner);
    assert.equal(diff.status, 200);
    assert.equal(diff.body.patch, "");
    const full = await getJson<GitDiffResponse>("/api/inspector/git/diff", inner);
    assert.match(full.body.patch, /inside after/);
    assert.doesNotMatch(full.body.patch, /private after/);
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});
