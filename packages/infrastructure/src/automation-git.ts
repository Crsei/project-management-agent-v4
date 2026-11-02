import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AutomationGitConfig } from '../../contracts/src/automation-git-sync.ts';
import { DomainError } from '../../domain/src/core.ts';

export type AutomationGitContext = { id: string; config: AutomationGitConfig; token: string | null };
export interface AutomationGitPort {
  capability(): { available: boolean; reason: string | null; secretsAvailable: boolean };
  seal(value: string, scope: string): string;
  open(value: string | null, scope: string): string | null;
  check(context: AutomationGitContext): Promise<{ remoteCommit: string | null }>;
  read(context: AutomationGitContext): Promise<{ remoteCommit: string | null; files: Record<string, string> }>;
  prepare(context: AutomationGitContext, remoteCommit: string | null, files: Record<string, string>, operationId: string): Promise<string>;
  push(context: AutomationGitContext, remoteCommit: string | null, commit: string): Promise<void>;
  reconcile(context: AutomationGitContext, commit: string): Promise<boolean>;
}
function failure(code: string, message: string): never { throw new DomainError(code, message, 503); }
export function encryptAutomationGitDocument(document: string, passphrase: string): string {
  const salt = randomBytes(16), iv = randomBytes(12), key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const aad = Buffer.from('pm-automation-git-document:v1'); cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(document, 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, algorithm: 'aes-256-gcm+scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}
export function decryptAutomationGitDocument(value: string, passphrase: string): string {
  try {
    const envelope = JSON.parse(value) as Record<string, unknown>;
    if (Object.keys(envelope).sort().join(',') !== 'algorithm,ciphertext,iv,salt,tag,version' || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm+scrypt') throw new Error();
    const decode = (name: string, length?: number) => { const field = envelope[name]; if (typeof field !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(field)) throw new Error(); const bytes = Buffer.from(field, 'base64'); if (length && bytes.length !== length) throw new Error(); return bytes; };
    const salt = decode('salt', 16), iv = decode('iv', 12), tag = decode('tag', 16), ciphertext = decode('ciphertext');
    if (ciphertext.length > 3 * 1024 * 1024) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32), iv); decipher.setAAD(Buffer.from('pm-automation-git-document:v1')); decipher.setAuthTag(tag);
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch { throw new DomainError('automation_git_decryption_failed', 'Encrypted definition authentication failed; verify the configured encryption key', 409); }
}
/** Dedicated bare checkout + private index: no business worktree and no untrusted checkout/hooks are ever used. */
export function createConfiguredAutomationGitPort(environment: NodeJS.ProcessEnv = process.env): AutomationGitPort {
  const root = environment.PM_AUTOMATION_GIT_ROOT, localRoot = environment.PM_AUTOMATION_GIT_LOCAL_REMOTE_ROOT;
  const allowedHosts = new Set((environment.PM_AUTOMATION_GIT_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  const masterText = environment.PM_AUTOMATION_GIT_MASTER_KEY;
  const master = masterText && /^[A-Za-z0-9+/]{43}=$/.test(masterText) ? Buffer.from(masterText, 'base64') : null;
  const rootConfigured = !!root && isAbsolute(root) && !(relative(resolve(root), process.cwd()) === '' || !relative(resolve(root), process.cwd()).startsWith('..')) && !(relative(process.cwd(), resolve(root)) === '' || !relative(process.cwd(), resolve(root)).startsWith('..'));
  const remoteConfigured = allowedHosts.size > 0 || !!localRoot && isAbsolute(localRoot);
  const configured = rootConfigured && remoteConfigured;
  function capability() { return { available: configured, reason: !rootConfigured ? 'Set PM_AUTOMATION_GIT_ROOT to a dedicated absolute directory outside the application/source worktree' : !remoteConfigured ? 'Set PM_AUTOMATION_GIT_ALLOWED_HOSTS or an absolute PM_AUTOMATION_GIT_LOCAL_REMOTE_ROOT before remote access' : null, secretsAvailable: master?.length === 32 }; }
  async function directory(id: string): Promise<string> {
    if (!configured || !root || !/^[a-f0-9-]{36}$/.test(id)) failure('automation_git_unconfigured', capability().reason ?? 'Invalid dedicated checkout identity');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const resolvedRoot = await realpath(root);
    const fromApplication = relative(process.cwd(), resolvedRoot), toApplication = relative(resolvedRoot, process.cwd());
    if (!fromApplication.startsWith('..') || !toApplication.startsWith('..')) failure('automation_git_unsafe_checkout', 'Resolved Git root overlaps the application worktree');
    for (let ancestor = resolvedRoot; ; ancestor = dirname(ancestor)) {
      try { await lstat(join(ancestor, '.git')); failure('automation_git_unsafe_checkout', 'Dedicated Git root must not be inside any source worktree'); } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
      if (dirname(ancestor) === ancestor) break;
    }
    const path = join(resolvedRoot, id); await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) failure('automation_git_unsafe_checkout', 'Dedicated checkout cannot be a symlink');
    const marker = join(path, '.pm-automation-git');
    try { if ((await readFile(marker, 'utf8')) !== id) failure('automation_git_unsafe_checkout', 'Dedicated checkout marker mismatch'); }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      if ((await readdir(path)).length) failure('automation_git_unsafe_checkout', 'Refusing to adopt a nonempty directory without the PM dedicated-checkout marker');
      await writeFile(marker, id, { flag: 'wx', mode: 0o600 });
    }
    return path;
  }
  async function remote(config: AutomationGitConfig): Promise<{ url: string; file: boolean }> {
    let url: URL; try { url = new URL(config.repository); } catch { throw new DomainError('automation_git_repository_invalid', 'Repository must be an allowlisted HTTPS URL or explicitly allowed local file URL', 400); }
    if (url.username || url.password || url.search || url.hash) throw new DomainError('automation_git_repository_invalid', 'Repository URLs must not contain credentials, query or fragment', 400);
    if (url.protocol === 'https:' && allowedHosts.has(url.hostname.toLowerCase()) && (!url.port || url.port === '443')) return { url: url.href, file: false };
    if (url.protocol === 'file:' && localRoot && !url.host) {
      const allowed = await realpath(localRoot), target = await realpath(decodeURIComponent(url.pathname)), rel = relative(allowed, target);
      if (!rel || !rel.startsWith('..') && !isAbsolute(rel)) {
        const objects = await lstat(join(target, 'objects')), headFile = await lstat(join(target, 'HEAD'));
        if (!objects.isDirectory() || objects.isSymbolicLink() || !headFile.isFile() || headFile.isSymbolicLink()) throw new DomainError('automation_git_repository_invalid', 'Local test remotes must be dedicated bare Git repositories', 400);
        return { url: target, file: true };
      }
    }
    throw new DomainError('automation_git_repository_forbidden', 'Repository is outside PM_AUTOMATION_GIT_ALLOWED_HOSTS / PM_AUTOMATION_GIT_LOCAL_REMOTE_ROOT', 403);
  }
  async function git(context: AutomationGitContext, args: string[], input?: string, index?: string): Promise<string> {
    const path = await directory(context.id), target = await remote(context.config);
    const env: NodeJS.ProcessEnv = { PATH: environment.PATH ?? '/usr/bin:/bin', HOME: path, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '0', GIT_OPTIONAL_LOCKS: '0' };
    if (index) env.GIT_INDEX_FILE = index;
    const settings = [['credential.helper', ''], ['core.hooksPath', '/dev/null'], ['core.attributesFile', '/dev/null'], ['protocol.allow', 'never'], ['protocol.https.allow', target.file ? 'never' : 'always'], ['protocol.file.allow', target.file ? 'always' : 'never'], ['http.followRedirects', 'false'], ['http.sslVerify', 'true'], ['http.proxy', ''], ['core.sshCommand', '/bin/false']];
    if (context.token && !target.file) settings.push(['http.extraHeader', `Authorization: Basic ${Buffer.from(`x-access-token:${context.token}`).toString('base64')}`]);
    settings.forEach(([key, value], number) => { env[`GIT_CONFIG_KEY_${number}`] = key; env[`GIT_CONFIG_VALUE_${number}`] = value; }); env.GIT_CONFIG_COUNT = String(settings.length);
    const resolvedArgs = args.map(arg => arg === '@REMOTE@' ? target.url : arg);
    const { promise, resolve: resolveResult, reject } = Promise.withResolvers<string>();
    const child = spawn('git', resolvedArgs, { cwd: path, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = []; let size = 0, failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 60000); timer.unref();
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 12 * 1024 * 1024) { failed = true; child.kill('SIGKILL'); } else output.push(chunk); });
    // Never surface Git stderr: remote URLs/headers/server messages may contain private data.
    child.stderr.resume(); child.on('error', () => { clearTimeout(timer); reject(new DomainError('automation_git_command_failed', 'Git executable unavailable or failed to start', 503)); });
    child.on('close', code => {
      clearTimeout(timer); let stdout: string;
      try { stdout = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output)); }
      catch { reject(new DomainError('automation_git_invalid_utf8', 'Git definition data and filenames must be valid UTF-8 text', 409)); return; }
      if (code !== 0 || failed) {
        if (!failed && args[0] === 'push' && /^!\t[^\n]+\t\[(?:rejected|remote rejected)\]/m.test(stdout)) reject(new DomainError('automation_git_push_rejected', 'Remote explicitly rejected the prepared commit (conflict or branch policy); no automatic retry was attempted', 409));
        else reject(new DomainError('automation_git_command_failed', 'Git operation failed or timed out; check remote access, branch and synchronization status', 503));
      } else resolveResult(stdout);
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
    return promise;
  }
  async function initialize(context: AutomationGitContext) {
    const path = await directory(context.id);
    try { if (!(await lstat(join(path, 'objects'))).isDirectory()) failure('automation_git_unsafe_checkout', 'Invalid dedicated Git object directory'); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; await git(context, ['init', '--bare', '--initial-branch=automation-sync', '.']); }
    return path;
  }
  async function head(context: AutomationGitContext): Promise<string | null> {
    await initialize(context); const result = await git(context, ['ls-remote', '--refs', '@REMOTE@', `refs/heads/${context.config.branch}`]);
    if (!result.trim()) return null; const hash = result.split(/\s/)[0]!; if (!/^[a-f0-9]{40,64}$/.test(hash)) failure('automation_git_invalid_remote', 'Remote returned an invalid commit'); return hash;
  }
  return {
    capability,
    seal(value, scope) {
      if (master?.length !== 32) failure('automation_git_secret_storage_unconfigured', 'Set PM_AUTOMATION_GIT_MASTER_KEY (32-byte base64) before storing private credentials');
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', master, iv); cipher.setAAD(Buffer.from(scope)); const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), body].map(buffer => buffer.toString('base64')).join('.');
    },
    open(value, scope) {
      if (!value) return null;
      if (master?.length !== 32) failure('automation_git_secret_storage_unconfigured', 'Private Git storage master key is unavailable');
      try { const [iv, tag, body] = value.split('.').map(part => Buffer.from(part, 'base64')); if (!iv || !tag || !body) throw new Error(); const decipher = createDecipheriv('aes-256-gcm', master, iv); decipher.setAAD(Buffer.from(scope)); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'); }
      catch { failure('automation_git_secret_storage_invalid', 'Private Git storage authentication failed'); }
    },
    async check(context) { return { remoteCommit: await head(context) }; },
    async read(context) {
      const remoteCommit = await head(context), files: Record<string, string> = {};
      if (!remoteCommit) return { remoteCommit, files };
      await git(context, ['fetch', '--no-tags', '--depth=1', '@REMOTE@', `refs/heads/${context.config.branch}`]);
      const tree = await git(context, ['ls-tree', '-rz', remoteCommit, '--', context.config.path]);
      let total = 0;
      for (const line of tree.split('\0').filter(Boolean)) {
        const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/.exec(line);
        if (!match) failure('automation_git_invalid_tree', 'Only regular definition files are accepted under the managed Git directory');
        const path = match[3]!;
        if (!path.endsWith('.automation-bundle.json') && !path.endsWith('.automation-bundle.json.enc')) continue;
        if (match[1] !== '100644' && match[1] !== '100755') failure('automation_git_invalid_tree', 'Symlinks are forbidden in the managed Git directory');
        if (!path.startsWith(context.config.path + '/') || path.slice(context.config.path.length + 1).includes('/')) failure('automation_git_invalid_tree', 'Definition files must be direct children of the configured path');
        const size = Number((await git(context, ['cat-file', '-s', match[2]!])).trim()); total += size;
        if (size > 4 * 1024 * 1024 || total > 10 * 1024 * 1024 || Object.keys(files).length >= 200) failure('automation_git_limits_exceeded', 'Remote definitions exceed the 200 files / 10 MiB synchronization limit');
        files[path] = await git(context, ['cat-file', 'blob', match[2]!]);
      }
      return { remoteCommit, files };
    },
    async prepare(context, remoteCommit, files, operationId) {
      const path = await initialize(context), index = join(path, `index-${operationId}`);
      if (remoteCommit) await git(context, ['read-tree', remoteCommit], undefined, index); else await git(context, ['read-tree', '--empty'], undefined, index);
      const tree = remoteCommit ? await git(context, ['ls-tree', '-rz', remoteCommit, '--', context.config.path]) : '';
      for (const line of tree.split('\0').filter(Boolean)) { const file = line.slice(line.indexOf('\t') + 1); if ((file.endsWith('.automation-bundle.json') || file.endsWith('.automation-bundle.json.enc')) && !Object.hasOwn(files, file)) await git(context, ['update-index', '--force-remove', '--', file], undefined, index); }
      for (const [file, content] of Object.entries(files)) {
        if (!file.startsWith(context.config.path + '/') || file.includes('\0') || file.includes('..')) failure('automation_git_invalid_path', 'Invalid generated Git path');
        const object = (await git(context, ['hash-object', '-w', '--stdin'], content, index)).trim(); await git(context, ['update-index', '--add', '--cacheinfo', `100644,${object},${file}`], undefined, index);
      }
      const treeHash = (await git(context, ['write-tree'], undefined, index)).trim();
      const args = ['-c', `user.name=${context.config.authorName}`, '-c', `user.email=${context.config.authorEmail}`, 'commit-tree', treeHash, ...(remoteCommit ? ['-p', remoteCommit] : [])];
      const commit = (await git(context, args, `PM automation synchronization ${operationId}\n`, index)).trim();
      await git(context, ['update-ref', `refs/pm-automation/${operationId}`, commit]);
      await unlink(index);
      return commit;
    },
    async push(context, remoteCommit, commit) { await git(context, ['push', '--porcelain', `--force-with-lease=refs/heads/${context.config.branch}:${remoteCommit ?? ''}`, '@REMOTE@', `${commit}:refs/heads/${context.config.branch}`]); },
    async reconcile(context, commit) {
      const current = await head(context); if (current === commit) return true; if (!current) return false;
      await git(context, ['fetch', '--no-tags', '@REMOTE@', `refs/heads/${context.config.branch}`]);
      const ancestors = await git(context, ['rev-list', current]); return ancestors.split('\n').includes(commit);
    },
  };
}
