import type { DeliveryFeedback, TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import { DeliveryError } from '../../../../../packages/application/src/task-code-delivery.ts';
import { execute } from './git.ts';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new DeliveryError('github_invalid', 'GitHub 返回格式无效。');
  return v as ObjectValue;
};
const string = (v: unknown): string => { if (typeof v !== 'string') throw new DeliveryError('github_invalid', 'GitHub 返回字段无效。'); return v; };
export class DeliveryGitHub {
  private readonly request: (path: string, input?: ObjectValue) => Promise<unknown>;
  constructor(request: (path: string, input?: ObjectValue) => Promise<unknown> = async (path, input) => JSON.parse(await execute('gh', ['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10', path, ...(input ? ['--input', '-'] : ['--method', 'GET'])], process.cwd(), input ? JSON.stringify(input) : undefined, true))) { this.request = request; }
  private base(v: TaskCodeDelivery): string {
    if (!v.git) throw new DeliveryError('repository_missing', '仓库未绑定。');
    return `/repos/${encodeURIComponent(v.git.owner)}/${encodeURIComponent(v.git.repo)}`;
  }
  private parsePr(v: TaskCodeDelivery, raw: unknown, exactHead = true): { number: number; url: string } {
    const pr = object(raw), head = object(pr.head), base = object(pr.base);
    if (!Number.isSafeInteger(pr.number) || Number(pr.number) <= 0 || head.ref !== v.git?.branch || (exactHead && head.sha !== v.head) || base.ref !== v.git?.baseBranch || object(head.repo).full_name !== `${v.git?.owner}/${v.git?.repo}` || object(base.repo).full_name !== `${v.git?.owner}/${v.git?.repo}` || !string(pr.body).includes(`PM-Delivery: ${v.id}`)) throw new DeliveryError('pr_conflict', 'PR 身份、代码版本或交付标记不匹配。');
    const url = string(pr.html_url);
    if (url !== `https://github.com/${v.git!.owner}/${v.git!.repo}/pull/${pr.number}`) throw new DeliveryError('pr_conflict', 'PR 地址不匹配。');
    return { number: Number(pr.number), url };
  }
  async find(v: TaskCodeDelivery): Promise<{ number: number; url: string } | null> {
    const prs = await this.request(`${this.base(v)}/pulls?state=all&head=${encodeURIComponent(`${v.git!.owner}:${v.git!.branch}`)}&base=${encodeURIComponent(v.git!.baseBranch)}&per_page=100`);
    if (!Array.isArray(prs) || prs.length > 1) throw new DeliveryError('pr_conflict', '无法唯一核对原 PR。');
    return prs.length ? this.parsePr(v, prs[0]) : null;
  }
  async create(v: TaskCodeDelivery): Promise<{ number: number; url: string }> {
    const pr = await this.request(`${this.base(v)}/pulls`, {
      title: `${v.taskId}: ${v.title}`, head: v.git!.branch, base: v.git!.baseBranch, draft: true,
      body: `PM-Delivery: ${v.id}\n\nTask: ${v.taskId}\nTask revision: ${v.taskRevision}\nHead: ${v.head}\n\nValidation exit: ${v.test?.exitCode}\nValidation output SHA256: ${v.test?.outputDigest}\n\nNo automatic merge, deployment or PM completion.`,
    });
    if (object(pr).draft !== true) throw new DeliveryError('pr_not_draft', '返回的 PR 不是草稿，停止后续操作。');
    return this.parsePr(v, pr);
  }
  private async pages(endpoint: string, field?: string): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 1; page <= 10; page++) {
      const body = await this.request(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const rows = field ? object(body)[field] : body;
      if (!Array.isArray(rows)) throw new DeliveryError('github_invalid', 'GitHub 列表无效。');
      all.push(...rows); if (rows.length < 100) return all;
    }
    throw new DeliveryError('github_incomplete', 'GitHub 列表超过安全上限，未保存不完整快照。');
  }
  async feedback(v: TaskCodeDelivery): Promise<DeliveryFeedback> {
    const base = this.base(v), endpoint = `${base}/pulls/${v.pr!.number}`;
    const pr = object(await this.request(endpoint));
    this.parsePr(v, pr, false);
    const head = string(object(pr.head).sha);
    const [checks, statuses, reviews] = await Promise.all([this.pages(`${base}/commits/${head}/check-runs`, 'check_runs'), this.pages(`${base}/commits/${head}/statuses`), this.pages(`${endpoint}/reviews`)]);
    const currentContexts = new Set<string>();
    const statusChecks = statuses.map(object).filter(s => { const key = string(s.context); if (currentContexts.has(key)) return false; currentContexts.add(key); return true; }).map(s => ({ name: string(s.context), status: string(s.state), conclusion: string(s.state) }));
    const again = object(await this.request(endpoint));
    if (object(again.head).sha !== head) throw new DeliveryError('github_changed', '读取期间 PR 已更新，请重新刷新。');
    if (pr.state !== 'open' && pr.state !== 'closed' || typeof pr.draft !== 'boolean') throw new DeliveryError('github_invalid', 'PR 状态无效。');
    return { head, state: pr.merged === true ? 'merged' : pr.state, draft: pr.draft, observedAt: new Date().toISOString(),
      checks: [...checks.map(raw => { const c = object(raw); return { name: string(c.name), status: string(c.status), conclusion: c.conclusion === null ? null : string(c.conclusion) }; }), ...statusChecks],
      reviews: reviews.map(raw => { const r = object(raw); if (!Number.isSafeInteger(r.id)) throw new DeliveryError('github_invalid', '评审 ID 无效。'); return { id: Number(r.id), author: string(object(r.user).login), state: string(r.state), commit: string(r.commit_id), body: string(r.body ?? '').slice(0, 4000) }; }),
    };
  }
}
