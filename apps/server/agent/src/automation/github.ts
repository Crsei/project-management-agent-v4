import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export type GitHubEvent = {
  key: string;
  signature: string;
  kind: "check" | "review" | "comment" | "conflict" | "head";
  actor: string | null;
  text: string;
};
export type GitHubSnapshot = {
  headSha: string;
  state: "open" | "closed" | "merged";
  events: GitHubEvent[];
};
export type GitHubWatchTarget = { owner: string; repo: string; number: number };
export interface GitHubReader {
  read(target: GitHubWatchTarget, signal: AbortSignal): Promise<GitHubSnapshot>;
}
export class GitHubReadError extends Error {
  retryAt: number;
  constructor(message: string, retryAt: number) {
    super(message);
    this.name = "GitHubReadError";
    this.retryAt = retryAt;
  }
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GitHub 返回了无效的数据结构。");
  return value as ObjectValue;
};
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const actor = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  return text((value as ObjectValue).login) || null;
};
const required = (value: unknown, label: string): string => {
  const result = text(value);
  if (!result) throw new Error(`GitHub 响应缺少 ${label}。`);
  return result;
};

/** Uses only server credentials: GH_TOKEN/GITHUB_TOKEN, then the local gh login. */
export class GitHubAdapter implements GitHubReader {
  private cooldownUntil = 0;
  private identity: { token: string; login: string } | null = null;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  constructor(request: typeof fetch = fetch, now: () => number = Date.now) {
    this.request = request;
    this.now = now;
  }

  private async token(): Promise<string> {
    const configured = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (configured) return configured;
    try {
      const { stdout } = await execFileAsync("gh", ["auth", "token", "--hostname", "github.com"], {
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      });
      const token = stdout.trim();
      if (token) return token;
    } catch {
      // Never forward stderr: auth helpers can print credential material.
    }
    throw new GitHubReadError(
      "GitHub 未认证：请在服务端配置 GH_TOKEN/GITHUB_TOKEN 或运行 gh auth login。",
      this.now() + 60_000,
    );
  }

  private async get(
    path: string,
    token: string,
    signal: AbortSignal,
  ): Promise<{ value: unknown; more: boolean }> {
    if (this.cooldownUntil > this.now())
      throw new GitHubReadError("GitHub 请求处于限流等待期。", this.cooldownUntil);
    let response: Response;
    try {
      response = await this.request(`https://api.github.com${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "agent-workspace-pr-watch",
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        redirect: "error",
      });
    } catch {
      signal.throwIfAborted();
      throw new GitHubReadError("GitHub 网络读取失败，未推进水位。", this.now() + 60_000);
    }
    const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
    const retry = response.headers.get("retry-after");
    const retryAt = retry
      ? /^\d+$/.test(retry)
        ? this.now() + Number(retry) * 1000
        : Date.parse(retry)
      : NaN;
    const limited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" || !!retry));
    if (limited || response.headers.get("x-ratelimit-remaining") === "0") {
      this.cooldownUntil = Math.max(
        this.now() + 60_000,
        Number.isFinite(reset) ? reset : 0,
        Number.isFinite(retryAt) ? retryAt : 0,
      );
    }
    if (!response.ok) {
      if (response.status === 401) this.identity = null;
      throw new GitHubReadError(
        limited
          ? "GitHub 已限流，按服务端 reset/retry-after 等待。"
          : `GitHub 读取失败（HTTP ${response.status}），未推进水位。`,
        Math.max(this.cooldownUntil, this.now() + 60_000),
      );
    }
    try {
      return {
        value: await response.json(),
        more: /rel="next"/.test(response.headers.get("link") || ""),
      };
    } catch {
      throw new GitHubReadError("GitHub 返回了无效 JSON，未推进水位。", this.now() + 60_000);
    }
  }

  private async pages(
    path: string,
    token: string,
    signal: AbortSignal,
    field?: string,
  ): Promise<ObjectValue[]> {
    const rows: ObjectValue[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const { value, more } = await this.get(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
        token,
        signal,
      );
      const collection = field ? object(value)[field] : value;
      if (!Array.isArray(collection))
        throw new GitHubReadError("GitHub 返回了无效列表，未推进水位。", this.now() + 60_000);
      rows.push(...collection.map(object));
      if (!more) return rows;
    }
    throw new GitHubReadError(
      "GitHub 数据超过单次安全读取上限，未推进水位。",
      this.now() + 300_000,
    );
  }

  async read(target: GitHubWatchTarget, signal: AbortSignal): Promise<GitHubSnapshot> {
    const token = await this.token();
    if (!this.identity || this.identity.token !== token) {
      const { value } = await this.get("/user", token, signal);
      this.identity = { token, login: required(object(value).login, "登录用户") };
    }
    const self = this.identity.login.toLowerCase();
    const base = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
    const { value } = await this.get(`${base}/pulls/${target.number}`, token, signal);
    const pr = object(value);
    const headSha = required(object(pr.head).sha, "head SHA");
    if (pr.state !== "open" && pr.state !== "closed")
      throw new Error("GitHub 返回了无效 PR 状态。");
    const state = pr.merged === true ? "merged" : pr.state;
    if (state !== "open") return { headSha, state, events: [] };
    // Each list must finish before the snapshot can advance its watermarks.
    const checks = await this.pages(
      `${base}/commits/${headSha}/check-runs`,
      token,
      signal,
      "check_runs",
    );
    const statuses = await this.pages(`${base}/commits/${headSha}/statuses`, token, signal);
    const reviews = await this.pages(`${base}/pulls/${target.number}/reviews`, token, signal);
    const comments = await this.pages(`${base}/issues/${target.number}/comments`, token, signal);
    const inline = await this.pages(`${base}/pulls/${target.number}/comments`, token, signal);
    const events: GitHubEvent[] = [];
    const append = (
      kind: GitHubEvent["kind"],
      key: string,
      by: string | null,
      data: ObjectValue,
      summary: string,
    ) => {
      if (by?.toLowerCase() === self) return;
      events.push({
        kind,
        key,
        actor: by,
        signature: JSON.stringify(data),
        text: summary.slice(0, 3000),
      });
    };
    for (const check of checks) {
      if (typeof check.id !== "number") throw new Error("GitHub check 缺少 ID。");
      const appOwner =
        check.app && typeof check.app === "object" ? actor((check.app as ObjectValue).owner) : null;
      append(
        "check",
        `check:${headSha}:${check.id}`,
        appOwner,
        {
          status: check.status,
          conclusion: check.conclusion,
          completedAt: check.completed_at,
          name: check.name,
        },
        `${text(check.name)}: ${text(check.status)} / ${text(check.conclusion)} ${text(check.html_url)}`,
      );
    }
    // Status history is newest-first. Track only the newest status per context.
    const contexts = new Set<string>();
    for (const status of statuses) {
      const context = required(status.context, "status context");
      if (contexts.has(context)) continue;
      contexts.add(context);
      append(
        "check",
        `status:${headSha}:${context}`,
        actor(status.creator),
        { state: status.state, description: status.description, id: status.id },
        `${context}: ${text(status.state)} ${text(status.description)}`,
      );
    }
    for (const review of reviews) {
      if (typeof review.id !== "number") throw new Error("GitHub review 缺少 ID。");
      append(
        "review",
        `review:${review.id}`,
        actor(review.user),
        {
          state: review.state,
          body: review.body,
          submittedAt: review.submitted_at,
          commitId: review.commit_id,
        },
        `${text(review.state)} (commit ${text(review.commit_id)}): ${text(review.body)}`,
      );
    }
    for (const [kind, collection] of [
      ["issue", comments],
      ["inline", inline],
    ] as const) {
      for (const comment of collection) {
        if (typeof comment.id !== "number") throw new Error("GitHub comment 缺少 ID。");
        append(
          "comment",
          `${kind}-comment:${comment.id}`,
          actor(comment.user),
          { body: comment.body, updatedAt: comment.updated_at },
          `${text(comment.path)} ${text(comment.body)}`.trim(),
        );
      }
    }
    // null means GitHub is still computing mergeability; never clear a known conflict on null.
    if (typeof pr.mergeable === "boolean") {
      append(
        "conflict",
        "conflict",
        null,
        { conflict: !pr.mergeable },
        pr.mergeable ? "PR 无合并冲突。" : "PR 存在合并冲突。",
      );
    }
    append("head", "head", null, { sha: headSha }, `PR head: ${headSha}`);
    return { headSha, state: "open", events };
  }
}
