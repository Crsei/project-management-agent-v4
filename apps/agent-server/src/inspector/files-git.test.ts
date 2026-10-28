import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type {
  GitDiffResponse,
  GitStatusResponse,
  InspectorFileResponse,
  InspectorTreeResponse,
} from "@agent-workspace/contracts/inspector";
import type { AgentScope } from "@agent-workspace/contracts/chat";

const projectDir = await mkdtemp(path.join(tmpdir(), "inspector-project-"));
const dataDir = await mkdtemp(path.join(tmpdir(), "inspector-data-"));
const repoDir = await mkdtemp(path.join(tmpdir(), "inspector-repo-"));
const outsideDir = await mkdtemp(path.join(tmpdir(), "inspector-outside-"));

process.env.AGENT_WORKSPACE_PROJECT_ROOT = projectDir;
process.env.AGENT_WORKSPACE_DATA_DIR = dataDir;
// Keep temp fixtures from discovering the repository that contains the OS temp dir.
process.env.GIT_CEILING_DIRECTORIES = tmpdir();

const workspaceId = "inspector-workspace";
const scopeRoots = new Map<string, string>();
let currentProjectId = "files";
scopeRoots.set(currentProjectId, projectDir);
let pmServer: Server;
let pmStatus = 200;
const pmRequests: { scope: AgentScope; cookie?: string; authorization?: string }[] = [];
const originalPmUrl = process.env.PM_API_URL;

// The app and its route modules snapshot environment-dependent state at load
// time, so the project/data roots must be set before a static import would run.
const { app } = await import("../app.ts");
const { ensureThread } = await import("../durable/threads.ts");
const { closeStore } = await import("../durable/store.ts");

async function getJson<T>(
  url: string,
  projectId: string | null = currentProjectId,
): Promise<{ status: number; body: T }> {
  const scoped = new URL(url, "http://localhost");
  scoped.searchParams.set("workspaceId", workspaceId);
  if (projectId !== null) scoped.searchParams.set("projectId", projectId);
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

async function setFileArea(directory: string): Promise<void> {
  currentProjectId = directory;
  scopeRoots.set(currentProjectId, directory);
}

before(async () => {
  pmServer = createServer(async (request, response) => {
    assert.equal(request.url, "/api/v1/agent-contexts/resolve");
    assert.equal(request.method, "POST");
    let body = "";
    for await (const chunk of request) body += chunk;
    const scope = JSON.parse(body) as AgentScope;
    pmRequests.push({ scope, cookie: request.headers.cookie, authorization: request.headers.authorization });
    const root = scope.workspaceId === workspaceId ? scopeRoots.get(scope.projectId ?? "workspace") : undefined;
    response.writeHead(pmStatus !== 200 ? pmStatus : root ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(root
      ? { scope, path: root, workspaceName: "Inspector", projectName: scope.projectId }
      : { error: "not_found_or_forbidden" }));
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
  closeStore();
  const closing = Promise.withResolvers<void>();
  pmServer.close((error) => error ? closing.reject(error) : closing.resolve());
  await closing.promise;
  if (originalPmUrl === undefined) delete process.env.PM_API_URL;
  else process.env.PM_API_URL = originalPmUrl;
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
  await setFileArea(repoDir);
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
  await setFileArea(repoDir);

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
  await setFileArea(repoDir);
  const { status, body } = await getJson<GitDiffResponse>("/api/inspector/git/diff?path=notes.md");
  assert.equal(status, 200);
  assert.equal(body.untracked, true);
  assert.equal(body.staged, false);
  assert.match(body.patch, /--- \/dev\/null/);
  assert.match(body.patch, /\+untracked content/);
});

test("diffs staged renames and worktree deletions", async () => {
  await setFileArea(repoDir);
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

test("normalizes paths when the project is a repository subdirectory", async () => {
  const outer = await mkdtemp(path.join(tmpdir(), "inspector-outer-"));
  const inner = path.join(outer, "app");
  try {
    await mkdir(inner, { recursive: true });
    await runGit(outer, ["init"]);
    await runGit(outer, ["config", "user.email", "test@example.com"]);
    await runGit(outer, ["config", "user.name", "Test"]);
    await writeFile(path.join(inner, "inside.txt"), "inside\n");
    await writeFile(path.join(outer, "outside.txt"), "outside\n");

    await setFileArea(inner);
    const status = await getJson<GitStatusResponse>("/api/inspector/git");
    assert.equal(status.status, 200);
    assert.equal(status.body.repo, true);
    assert.deepEqual(
      status.body.files.map((file) => file.path),
      ["inside.txt"],
    );

    const diff = await getJson<GitDiffResponse>("/api/inspector/git/diff?path=inside.txt");
    assert.equal(diff.status, 200);
    assert.match(diff.body.patch, /b\/inside\.txt/);
    assert.doesNotMatch(diff.body.patch, /outside\.txt/);
  } finally {
    await setFileArea(repoDir);
    await rm(outer, { recursive: true, force: true });
  }
});

test("reports non-repositories", async () => {
  await setFileArea(projectDir);
  const status = await getJson<GitStatusResponse>("/api/inspector/git");
  assert.equal(status.status, 200);
  assert.equal(status.body.repo, false);
  assert.deepEqual(status.body.files, []);

  const diff = await getJson<{ error: string; code: string }>("/api/inspector/git/diff?path=a.txt");
  assert.equal(diff.status, 409);
  assert.equal(diff.body.code, "not_a_repo");

  await setFileArea(repoDir);
});

test("requires explicit scope on every endpoint before resolving PM", async () => {
  const count = pmRequests.length;
  for (const endpoint of ["files", "file", "git", "git/diff"]) {
    for (const query of [
      "",
      "?projectId=files",
      "?workspaceId=",
      `?workspaceId=${workspaceId}&projectId=`,
      `?workspaceId=${workspaceId}&workspaceId=forged`,
      `?workspaceId=${workspaceId}&root=${encodeURIComponent(outsideDir)}`,
      `?workspaceId=${workspaceId}&cwd=${encodeURIComponent(outsideDir)}`,
    ]) {
      const response = await app.request(`/api/inspector/${endpoint}${query}`, { headers: { host: "localhost" } });
      assert.equal(response.status, 400, `${endpoint}${query}`);
    }
  }
  assert.equal(pmRequests.length, count);
});

test("validates persisted scope and denies unknown, legacy and forged thread bindings", async () => {
  const scope = { workspaceId, projectId: "files" };
  ensureThread("inspector-scoped", undefined, scope);
  ensureThread("inspector-legacy");
  const valid = await getJson<InspectorTreeResponse>("/api/inspector/files?threadId=inspector-scoped", "files");
  assert.equal(valid.status, 200);
  for (const endpoint of ["files", "file", "git", "git/diff"]) {
    const count = pmRequests.length;
    for (const [threadId, projectId, expected] of [
      ["missing", "files", 404],
      ["inspector-legacy", "files", 412],
      ["inspector-scoped", "forged", 409],
      ["", "files", 400],
    ] as const) {
      const response = await getJson(`/api/inspector/${endpoint}?threadId=${threadId}`, projectId);
      assert.equal(response.status, expected);
    }
    assert.equal(pmRequests.length, count);
  }
});

test("resolves simultaneous workspace and project requests independently with request-local auth", async () => {
  scopeRoots.set("workspace", projectDir);
  scopeRoots.set("repo", repoDir);
  const [workspace, project, repo, nonRepo] = await Promise.all([
    getJson<InspectorTreeResponse>("/api/inspector/files", null),
    getJson<InspectorTreeResponse>("/api/inspector/files", "repo"),
    getJson<GitStatusResponse>("/api/inspector/git", "repo"),
    getJson<GitStatusResponse>("/api/inspector/git", null),
  ]);
  assert.equal(workspace.body.root, projectDir);
  assert.equal(project.body.root, repoDir);
  assert.ok(!workspace.body.entries.some((entry) => entry.name === "tracked.txt"));
  assert.ok(!project.body.entries.some((entry) => entry.name === "a.txt"));
  assert.equal(repo.body.repo, true);
  assert.equal(nonRepo.body.repo, false);
  const [own, other] = await Promise.all([
    getJson<InspectorFileResponse>("/api/inspector/file?path=a.txt", null),
    getJson("/api/inspector/file?path=a.txt", "repo"),
  ]);
  assert.equal(own.body.content, "alpha\n");
  assert.equal(other.status, 404);
  for (const suffix of ["first", "second"]) {
    const response = await app.request(`/api/inspector/files?workspaceId=${workspaceId}`, {
      headers: { host: "localhost", cookie: `pm_v3_session=${suffix}`, authorization: `Bearer ${suffix}` },
    });
    assert.equal(response.status, 200);
    assert.equal(pmRequests.at(-1)?.cookie, `pm_v3_session=${suffix}`);
    assert.equal(pmRequests.at(-1)?.authorization, `Bearer ${suffix}`);
  }
  await getJson("/api/inspector/files", null);
  assert.equal(pmRequests.at(-1)?.cookie, undefined);
  assert.equal(pmRequests.at(-1)?.authorization, undefined);
});

test("keeps same-origin and access guards ahead of scope resolution", async () => {
  const count = pmRequests.length;
  const url = `/api/inspector/files?workspaceId=${workspaceId}&projectId=files`;
  const crossOrigin = await app.request(url, { headers: { host: "localhost", origin: "https://evil.invalid" } });
  assert.equal(crossOrigin.status, 403);
  const previousToken = process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  process.env.AGENT_WORKSPACE_ACCESS_TOKEN = "inspector-test-access-token";
  try {
    const unauthenticated = await app.request(url, { headers: { host: "localhost" } });
    assert.equal(unauthenticated.status, 401);
  } finally {
    if (previousToken === undefined) delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
    else process.env.AGENT_WORKSPACE_ACCESS_TOKEN = previousToken;
  }
  assert.equal(pmRequests.length, count);
});

test("returns PM auth, forged scope and availability failures without a global fallback", async () => {
  const forged = await getJson("/api/inspector/files", "forged");
  assert.equal(forged.status, 404);
  for (const status of [401, 403, 503]) {
    pmStatus = status;
    try {
      for (const endpoint of ["files", "file", "git", "git/diff"]) {
        const response = await getJson(`/api/inspector/${endpoint}`, "files");
        assert.equal(response.status, status);
      }
    } finally {
      pmStatus = 200;
    }
  }
  const pmUrl = process.env.PM_API_URL;
  process.env.PM_API_URL = "invalid-url";
  try {
    assert.equal((await getJson("/api/inspector/files", "files")).status, 503);
  } finally {
    process.env.PM_API_URL = pmUrl;
  }
});

test("uses the current PM directory on each request without changing the thread binding", async () => {
  ensureThread("inspector-rebound", undefined, { workspaceId, projectId: "rebound" });
  scopeRoots.set("rebound", projectDir);
  try {
    const before = await getJson<InspectorTreeResponse>("/api/inspector/files?threadId=inspector-rebound", "rebound");
    assert.equal(before.body.root, projectDir);
    scopeRoots.set("rebound", repoDir);
    const after = await getJson<InspectorTreeResponse>("/api/inspector/files?threadId=inspector-rebound", "rebound");
    assert.equal(after.body.root, repoDir);
    const git = await getJson<GitStatusResponse>("/api/inspector/git?threadId=inspector-rebound", "rebound");
    assert.equal(git.body.repo, true);
    scopeRoots.set("rebound", path.join(outsideDir, "missing-area"));
    for (const endpoint of ["files", "file", "git", "git/diff"]) {
      const unavailable = await getJson(`/api/inspector/${endpoint}?threadId=inspector-rebound`, "rebound");
      assert.equal(unavailable.status, 412);
    }
  } finally {
    scopeRoots.delete("rebound");
  }
});

test("denies symlinks outside the selected scope, including missing descendants", async () => {
  for (const endpoint of ["files", "file", "git/diff"]) {
    for (const target of ["escape", "escape/deleted.txt"]) {
      const result = await getJson(`/api/inspector/${endpoint}?path=${target}`, "files");
      assert.equal(result.status, 400);
    }
  }
});

test("treats Git pathspec magic as a literal path within the selected subtree", async () => {
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
    scopeRoots.set("nested", inner);
    const status = await getJson<GitStatusResponse>("/api/inspector/git", "nested");
    assert.equal(status.body.root, inner);
    assert.deepEqual(status.body.files, []);
    const diff = await getJson<GitDiffResponse>(`/api/inspector/git/diff?path=${encodeURIComponent(":(top)outside.txt")}`, "nested");
    assert.equal(diff.status, 200);
    assert.equal(diff.body.patch, "");
    const full = await getJson<GitDiffResponse>("/api/inspector/git/diff", "nested");
    assert.equal(full.body.patch, "");
  } finally {
    scopeRoots.delete("nested");
    await rm(outer, { recursive: true, force: true });
  }
});
