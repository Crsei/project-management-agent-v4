import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LocalVerification, TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import { DeliveryError } from '../../../../../packages/application/src/task-code-delivery.ts';
import { git, readTree } from './git.ts';

function blocked(message: string): never { throw new DeliveryError('local_verification_blocked', message); }
export async function assertLocalVerifier() {
  if (process.platform !== 'linux' || process.versions.node.split('.')[0] !== '24') blocked('本地验证需要 Linux / Node 24；不会回退为无隔离执行。');
  for (const file of ['/usr/bin/bwrap', '/usr/bin/prlimit', '/usr/local/bin/node', '/usr/local/bin/npm']) await access(file).catch(() => blocked('本地隔离验证器未安装；不会回退为无隔离执行。'));
}
export function localTestArguments(code: string): string[] {
  return ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
    '--dev', '/dev', '--tmpfs', '/tmp', '--bind', code, '/app', '--chdir', '/app', '--clearenv',
    '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'HOME', '/tmp',
    '--setenv', 'CI', '1', '--setenv', 'NODE_OPTIONS', '--max-old-space-size=256 --test-reporter=tap',
    '--setenv', 'npm_config_cache', '/tmp/npm', '--setenv', 'npm_config_audit', 'false', '--setenv', 'npm_config_fund', 'false',
    '--', '/usr/local/bin/npm', 'test'];
}
export function testCounts(output: string): LocalVerification['counts'] {
  const counts = {} as NonNullable<LocalVerification['counts']>;
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const) {
    // Exactly one top-level TAP summary. Missing/duplicate summaries are not success.
    const found = [...output.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    if (found.length !== 1) return null;
    counts[key] = Number(found[0]![1]);
    if (!Number.isSafeInteger(counts[key])) return null;
  }
  return counts;
}
function countsPass(counts: LocalVerification['counts']) {
  return !!counts && counts.tests > 0 && counts.pass === counts.tests && !counts.fail && !counts.cancelled && !counts.skipped && !counts.todo;
}
/** A disposable source copy, never a worktree/home/PM mount. The network namespace has only loopback. */
export async function runLocalVerification(value: TaskCodeDelivery, command = 'npm test') {
  if (command !== 'npm test') blocked('当前本地隔离验证仅支持 Node 应用的 npm test；其他命令未开放。');
  await assertLocalVerifier();
  const before = await readTree(value), root = value.git!.directory;
  if (value.step === 'pr' && (!value.head || before.head !== value.head || before.files.length)) blocked('待验证的提交已变化，未执行测试。');
  // Final verification reads immutable commit blobs, never a mutable checkout snapshot.
  const blobs = new Map<string, { mode: string; oid: string; size: number }>();
  if (!before.files.length) {
    for (const row of (await git(root, 'ls-tree', '-rzl', before.head)).split('\0').filter(Boolean)) {
      const match = /^(\d{6}) blob ([a-f0-9]{40,64})\s+(\d+)\t([\s\S]+)$/.exec(row);
      if (!match || !['100644', '100755'].includes(match[1]!)) blocked('本地版本验证不接受链接、子模块或未知 Git 对象。');
      blobs.set(match[4]!, { mode: match[1]!, oid: match[2]!, size: Number(match[3]) });
    }
  }
  const names = !before.files.length ? [...blobs.keys()] : [...new Set((await git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')).split('\0').filter(Boolean))];
  if (names.length > 1000) blocked('本地验证源码超过 1000 文件限制。');
  const directory = await mkdtemp(path.join(tmpdir(), 'pm-local-test-'));
  try {
    let size = 0;
    for (const name of names) {
      if (path.isAbsolute(name) || name.split('/').some(p => !p || p === '..' || p === '.')) blocked('本地验证文件路径无效。');
      // Never read credentials or managed metadata, including checked-in hidden configuration.
      if (name.split('/').some(p => p.startsWith('.') || p === 'node_modules' || /^(credentials|secrets?|id_rsa|id_ed25519)$/i.test(p)) || /\.(pem|key|p12)$/i.test(name)) continue;
      const blob = blobs.get(name);
      let content: Buffer, executable: boolean;
      if (blob) {
        if ((size += blob.size) > 16 * 1024 * 1024) blocked('本地验证源码超过 16 MiB。');
        const text = await git(root, 'cat-file', 'blob', blob.oid);
        // The current verifier accepts text-only Node projects, fail closed rather than corrupt binary fixtures.
        if (text.includes('\ufffd') || Buffer.byteLength(text) !== blob.size) blocked('本地验证暂不支持二进制或非 UTF-8 文件。');
        content = Buffer.from(text); executable = blob.mode === '100755';
      } else {
        const source = path.join(root, name), stat = await lstat(source).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        if (!stat) continue;
        if (!stat.isFile() || stat.isSymbolicLink() || await realpath(source) !== source || (size += stat.size) > 16 * 1024 * 1024) blocked('本地验证只接受合计 16 MiB 内的普通源码文件，不接受链接。');
        content = await readFile(source); executable = !!(stat.mode & 0o111);
      }
      const target = path.join(directory, name); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { flag: 'wx', mode: executable ? 0o700 : 0o600 });
    }
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as { scripts?: { test?: string }; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    if (!pkg.scripts?.test || !/^node --test [A-Za-z0-9_./* -]+$/.test(pkg.scripts.test) || Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.devDependencies ?? {}).length) blocked('当前隔离验证支持无外部依赖的 Node 原生测试项目；不会联网安装依赖。');
    const copied = await readTree(value);
    if (copied.head !== before.head || copied.fingerprint !== before.fingerprint) blocked('复制验证快照期间代码发生变化，未执行测试。');
    const result = await new Promise<{ exitCode: number | null; outputDigest: string; counts: LocalVerification['counts']; passed: boolean }>((resolve, reject) => {
      const digest = createHash('sha256'); let output = '', bytes = 0, stopped = false;
      const child = spawn('/usr/bin/prlimit', ['--cpu=120', '--nofile=128', '--fsize=16777216', '--', '/usr/bin/bwrap', ...localTestArguments(directory)], { env: {}, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Owned group already exited. */ } };
      const timer = setTimeout(() => { stopped = true; kill(); }, 120_000);
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => { digest.update(chunk); bytes += chunk.length; if (bytes > 1024 * 1024) { stopped = true; kill(); } else output += chunk.toString('utf8'); });
      child.once('error', () => { clearTimeout(timer); kill(); reject(new DeliveryError('local_verification_unavailable', '本地隔离进程启动失败，未进行无隔离回退。')); });
      child.once('close', code => { clearTimeout(timer); kill(); const counts = testCounts(output); resolve({ exitCode: stopped ? null : code, outputDigest: digest.digest('hex'), counts, passed: !stopped && code === 0 && countsPass(counts) }); });
    });
    return { ...result, executor: 'linux-bwrap-node24-v1' as const };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
