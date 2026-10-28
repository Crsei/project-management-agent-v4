import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubAdapter, GitHubReadError } from "./github.ts";

const target = { owner: "owner", repo: "repo", number: 1 };
const headSha = "a".repeat(40);

test("GitHub adapter polls all event classes, paginates, ignores self, and keeps credentials server-side", async (t) => {
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "test-server-token-not-a-real-credential";
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });
  const requests: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer test-server-token-not-a-real-credential",
    );
    assert.equal(init?.redirect, "error");
    if (url.pathname === "/user") return Response.json({ login: "workspace-bot" });
    if (url.pathname.endsWith("/pulls/1"))
      return Response.json({
        head: { sha: headSha },
        state: "open",
        merged: false,
        mergeable: false,
      });
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({
        check_runs: [{ id: 1, name: "CI", status: "completed", conclusion: "failure" }],
      });
    if (url.pathname.endsWith("/statuses"))
      return Response.json([
        { id: 3, context: "legacy", state: "success", creator: { login: "ci" } },
        { id: 2, context: "legacy", state: "pending", creator: { login: "ci" } },
      ]);
    if (url.pathname.endsWith("/reviews"))
      return Response.json([
        {
          id: 4,
          commit_id: headSha,
          state: "CHANGES_REQUESTED",
          body: "Needs work",
          user: { login: "reviewer" },
        },
        {
          id: 5,
          commit_id: headSha,
          state: "COMMENTED",
          body: "self review",
          user: { login: "WORKSPACE-BOT" },
        },
        {
          id: 6,
          commit_id: "old",
          state: "APPROVED",
          body: "old head",
          user: { login: "reviewer" },
        },
      ]);
    if (url.pathname.endsWith("/issues/1/comments")) {
      if (url.searchParams.get("page") === "1")
        return Response.json(
          [{ id: 7, body: "Self-generated", updated_at: "a", user: { login: "workspace-bot" } }],
          { headers: { link: '<https://api.github.com/example?page=2>; rel="next"' } },
        );
      return Response.json([
        { id: 8, body: "External request", updated_at: "b", user: { login: "human" } },
      ]);
    }
    if (url.pathname.endsWith("/pulls/1/comments"))
      return Response.json([
        {
          id: 9,
          path: "file.ts",
          body: "Inline feedback",
          updated_at: "c",
          user: { login: "human" },
        },
      ]);
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  };
  const result = await new GitHubAdapter(request).read(target, new AbortController().signal);
  assert.equal(result.state, "open");
  assert.deepEqual(result.events.map((event) => event.kind).sort(), [
    "check",
    "check",
    "comment",
    "comment",
    "conflict",
    "head",
    "review",
    "review",
  ]);
  assert.equal(
    result.events.some((event) => /self review|Self-generated/.test(event.text)),
    false,
  );
  assert.ok(
    result.events.some((event) => event.key === "review:6" && event.text.includes("commit old")),
  );
  assert.equal(result.events.filter((event) => event.key.includes("status:")).length, 1);
  assert.ok(requests.some((url) => url.includes("page=2")));
  assert.equal(JSON.stringify(result).includes("test-server-token"), false);
});

test("GitHub rate reset prevents further reads until the server deadline and never leaks response bodies", async (t) => {
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "server-test-token";
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });
  let now = 1_000_000;
  let calls = 0;
  const request: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) return Response.json({ login: "self" });
    return new Response("sensitive upstream text must not leak", {
      status: 429,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1200", "retry-after": "120" },
    });
  };
  const adapter = new GitHubAdapter(request, () => now);
  await assert.rejects(
    () => adapter.read(target, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof GitHubReadError);
      assert.equal(error.retryAt, 1_200_000);
      assert.equal(error.message.includes("sensitive"), false);
      return true;
    },
  );
  const count = calls;
  await assert.rejects(() => adapter.read(target, new AbortController().signal));
  assert.equal(calls, count);
  now = 1_200_000;
  await assert.rejects(() => adapter.read(target, new AbortController().signal));
  assert.equal(calls, count + 1);
});

test("GitHub closed and merged reads stop before expensive event collection", async (t) => {
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "server-test-token";
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });
  for (const merged of [false, true]) {
    let calls = 0;
    const request: typeof fetch = async (input) => {
      calls += 1;
      if (String(input).endsWith("/user")) return Response.json({ login: "self" });
      return Response.json({ head: { sha: headSha }, state: "closed", merged });
    };
    const result = await new GitHubAdapter(request).read(target, new AbortController().signal);
    assert.equal(result.state, merged ? "merged" : "closed");
    assert.equal(calls, 2);
    assert.deepEqual(result.events, []);
  }
});

test("GitHub malformed pages fail the entire snapshot instead of inventing success", async (t) => {
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "server-test-token";
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });
  const request: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/user")) return Response.json({ login: "self" });
    if (url.endsWith("/pulls/1"))
      return Response.json({ head: { sha: headSha }, state: "open", merged: false });
    return Response.json({ unexpected: true });
  };
  await assert.rejects(
    () => new GitHubAdapter(request).read(target, new AbortController().signal),
    GitHubReadError,
  );
});
