import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DeliveryError } from '../../../../../packages/application/src/task-code-delivery.ts';
import type { DeliveryGit, DeliveryTree, TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import { dataDirectory } from '../paths.ts';

const safeEnv = () => Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK'].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : []));
export function execute(file: string, args: string[], cwd: string, input?: string, github = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...safeEnv(), GIT_TERMINAL_PROMPT: '0', ...(github ? { GH_TOKEN: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '', GH_PROMPT_DISABLED: '1' } : {}) };
    const child = execFile(file, args, { cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new DeliveryError('external_command_failed', `${file === 'git' ? 'Git' : 'GitHub'} 操作未确认，请检查服务端认证与仓库状态。`));
      else resolve(stdout);
    });
    child.stdin?.end(input);
  });
}
export const git = (cwd: string, ...args: string[]) => execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', ...args], cwd);
export function githubRepository(remote: string): { owner: string; repo: string } {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if (!match || !match[1] || !match[2] || ['.', '..'].includes(match[2])) throw new DeliveryError('github_remote_required', 'origin 必须是 github.com 的无凭据 HTTPS 或 SSH 仓库地址；不接受路径、内嵌 token 或未知主机。');
  return { owner: match[1], repo: match[2] };
}
function binding(value: TaskCodeDelivery): DeliveryGit {
  if (!value.git) throw new DeliveryError('worktree_missing', '没有已确认的工作目录。');
  return value.git;
}
export async function prepareWorktree(value: TaskCodeDelivery, directory: string, baseBranch: string, run: typeof git = git): Promise<DeliveryGit> {
  const root = await realpath(directory);
  if (path.resolve((await run(root, 'rev-parse', '--show-toplevel')).trim()) !== root) throw new DeliveryError('repository_root_required', '项目文件区域必须是已登记 Git 仓库根目录。');
  await run(root, 'check-ref-format', '--branch', baseBranch);
  const remote = (await run(root, 'remote', 'get-url', 'origin')).trim();
  const repository = githubRepository(remote);
  if ((await run(root, 'remote', 'get-url', '--push', 'origin')).trim() !== remote) throw new DeliveryError('remote_mismatch', 'origin 推送地址与读取地址不同。');
  // Fetch only the explicitly selected branch; never checkout/reset the user's working tree.
  await run(root, 'fetch', '--no-tags', 'origin', `refs/heads/${baseBranch}`);
  const baseSha = (await run(root, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}')).trim();
  const branch = `codex/${value.taskId.toLowerCase()}-${value.id.slice(0, 8)}`;
  const parent = path.join(dataDirectory(), 'task-worktrees');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== path.resolve(parent)) throw new DeliveryError('unsafe_directory', '工作目录父路径不能包含符号链接。');
  const worktree = path.join(parent, value.id);
  await run(root, 'worktree', 'add', '-b', branch, '--', worktree, baseSha);
  const stat = await lstat(worktree);
  return { ...repository, root, directory: worktree, directoryIdentity: `${stat.dev}:${stat.ino}`, commonDirectory: (await run(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim(), remote, baseBranch, baseSha, branch };
}
export async function verifyWorktree(value: TaskCodeDelivery): Promise<void> {
  const b = binding(value), stat = await lstat(b.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(b.directory) !== b.directory || `${stat.dev}:${stat.ino}` !== b.directoryIdentity) throw new DeliveryError('worktree_changed', '工作目录身份发生变化，拒绝执行。');
  const [root, branch, common, remote, push] = await Promise.all([
    git(b.directory, 'rev-parse', '--show-toplevel'), git(b.directory, 'branch', '--show-current'), git(b.directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'), git(b.directory, 'remote', 'get-url', 'origin'), git(b.directory, 'remote', 'get-url', '--push', 'origin'),
  ]);
  if (root.trim() !== b.directory || branch.trim() !== b.branch || common.trim() !== b.commonDirectory || remote.trim() !== b.remote || push.trim() !== b.remote) throw new DeliveryError('repository_changed', '仓库、分支或远端已改变，拒绝继续。');
}
const sensitive = /(^|\/)(?:\.git|\.pm|\.local|\.env(?:\..*)?|credentials|secrets?|id_rsa|id_ed25519)(\/|$)|\.(?:pem|key|p12)$/i;
export async function readTree(value: TaskCodeDelivery, comparisonHead?: string): Promise<DeliveryTree> {
  await verifyWorktree(value);
  const cwd = binding(value).directory;
  const head = (await git(cwd, 'rev-parse', 'HEAD')).trim();
  const reference = comparisonHead ?? head;
  const changed = (await git(cwd, 'diff', '--no-renames', '--name-only', '-z', reference, '--')).split('\0').filter(Boolean);
  const untracked = (await git(cwd, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
  const files = [...new Set([...changed, ...untracked])].sort();
  if (files.length > 1000 || files.some(p => sensitive.test(p) || path.isAbsolute(p) || p.split('/').includes('..'))) throw new DeliveryError('unsafe_changes', '变更含私有/管理文件或超出 1000 文件上限，请先人工整理。');
  const diff = await git(cwd, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', reference, '--');
  // Canonical content fingerprint, independent of staging and rename detection.
  const digest = createHash('sha256').update(reference);
  let size = 0;
  for (const name of files) {
    const filename = path.join(cwd, name);
    const stat = await lstat(filename).catch(error => { if (error?.code === 'ENOENT') return null; throw error; });
    if (!stat) { digest.update(JSON.stringify({ name, deleted: true })); continue; }
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(filename) !== filename || (size += stat.size) > 16 * 1024 * 1024) throw new DeliveryError('unsafe_changes', '变更必须是普通文件，且合计不超过 16 MiB。');
    const content = await readFile(filename);
    digest.update(JSON.stringify({ name, executable: stat.mode & 0o111, bytes: content.length })).update(content);
  }
  return { head, files, fingerprint: digest.digest('hex'), diff: diff.slice(0, 64_000) + (diff.length > 64_000 ? '\n[diff truncated; inspect the worktree before committing]' : '') };
}
export async function commitTree(value: TaskCodeDelivery): Promise<string> {
  const b = binding(value), tree = await readTree(value);
  if (tree.fingerprint !== value.test?.fingerprint || !value.test.passed) throw new DeliveryError('stale_test', '变更与测试证据不一致。');
  if (!(await git(b.directory, 'config', 'user.name')).trim() || !(await git(b.directory, 'config', 'user.email')).trim()) throw new DeliveryError('git_identity_required', '请先配置服务用户的 Git 提交身份。');
  // This is an owned worktree; the exact inspected set (including deletions) is the approval scope.
  await git(b.directory, '--literal-pathspecs', 'add', '--', ...tree.files);
  if ((await readTree(value)).fingerprint !== tree.fingerprint) throw new DeliveryError('changes_changed', '暂存期间内容已变化，未提交。');
  await git(b.directory, '-c', 'commit.gpgsign=false', 'commit', '-m', `${value.taskId}: ${value.title}\n\nPM-Delivery: ${value.id}`);
  if ((await readTree(value, tree.head)).fingerprint !== tree.fingerprint || (await readTree(value)).files.length) throw new DeliveryError('changes_changed', '提交后出现并行修改，停止发布。');
  return (await git(b.directory, 'rev-parse', 'HEAD')).trim();
}
export async function readRemoteHead(value: TaskCodeDelivery): Promise<string | null> {
  const b = binding(value);
  const output = (await git(b.directory, 'ls-remote', '--refs', b.remote, `refs/heads/${b.branch}`)).trim();
  return output ? output.split(/\s/)[0]! : null;
}
export async function pushTree(value: TaskCodeDelivery): Promise<void> {
  await verifyWorktree(value);
  const b = binding(value), tree = await readTree(value);
  if (tree.files.length || tree.head !== value.head) throw new DeliveryError('stale_head', '当前提交已变化。');
  const remote = await readRemoteHead(value);
  if (remote && remote !== value.head) throw new DeliveryError('remote_changed', '远端已有不同提交，不覆盖、不强推。');
  // Empty lease is an atomic create-only guard: it cannot rewrite an existing remote branch.
  if (!remote) await git(b.directory, 'push', `--force-with-lease=refs/heads/${b.branch}:`, b.remote, `${value.head}:refs/heads/${b.branch}`);
  if (await readRemoteHead(value) !== value.head) throw new DeliveryError('push_unknown', '远端提交尚未核对一致。');
}
/** Explicitly approved repository command; credential-minimized, bounded, no raw output persistence. */
export async function testTree(value: TaskCodeDelivery, command: string): Promise<{ exitCode: number | null; outputDigest: string }> {
  await verifyWorktree(value);
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const child = spawn('/bin/sh', ['-c', command], { cwd: binding(value).directory, env: safeEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const stopGroup = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } } };
    const timer = setTimeout(() => { timedOut = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } } }, 120_000);
    child.stdout.on('data', b => digest.update(b)); child.stderr.on('data', b => digest.update(b));
    child.once('error', () => { clearTimeout(timer); reject(new DeliveryError('test_start_failed', '验证命令无法启动。')); });
    child.once('close', code => { clearTimeout(timer); stopGroup(); resolve({ exitCode: timedOut ? null : code, outputDigest: digest.digest('hex') }); });
  });
}

export async function reconcileCommit(value: TaskCodeDelivery): Promise<string | null> {
  if (value.pending?.action !== 'commit' || !value.pending.head || !value.pending.fingerprint) return null;
  await verifyWorktree(value);
  const [message, parents, head] = (await git(binding(value).directory, 'log', '-1', '--format=%B%x00%P%x00%H')).trim().split('\0');
  if (!message?.split('\n').includes(`PM-Delivery: ${value.id}`) || parents !== value.pending.head || !head) return null;
  if ((await readTree(value)).files.length || (await readTree(value, parents)).fingerprint !== value.pending.fingerprint) return null;
  return head;
}
export async function preflightPrepare(directory: string, baseBranch: string): Promise<void> {
  const root = await realpath(directory);
  if ((await git(root, 'rev-parse', '--show-toplevel')).trim() !== root) throw new DeliveryError('repository_root_required', '请先将项目文件区域登记为 Git 仓库根目录。');
  await git(root, 'check-ref-format', '--branch', baseBranch);
  const remote = (await git(root, 'remote', 'get-url', 'origin')).trim(); githubRepository(remote);
  const branch = (await git(root, 'ls-remote', '--heads', remote, `refs/heads/${baseBranch}`)).trim();
  if (!branch) throw new DeliveryError('base_missing', '远端基准分支不存在；没有创建交付记录或分支。');
}
