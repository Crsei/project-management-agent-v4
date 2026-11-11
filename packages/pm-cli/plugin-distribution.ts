import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { privateDirectory } from './private-files.ts';
import { serviceOrigin } from './auth.ts';
import { pluginCapabilities, PLUGIN_OPERATION_POLICY } from './plugin-capabilities.ts';

const sourceRoot = fileURLToPath(new URL('../../plugins/dovspace-pm/', import.meta.url));
const ownerFile = '.dovspace-owned.json';
const pluginName = 'dovspace-pm';
const pluginSchemaId = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const mcpSchemaId = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const PLUGIN_POLICY_NOTICE = 'dovspace-pm: new operation policy is full access / audit-only; no new allow/deny prompt. Existing authentication, OAuth consent, PM authority, revocation and explicit deployment approvals remain enforced. Uninstall does not revoke OAuth or delete business history.';

// A locally pinned validator for the generated Agent Plugins 1.0.0 remote-only profile.
// No schema is downloaded while generating or loading a package.
const metadata = z.object({ name: z.string().optional(), email: z.string().optional(), url: z.string().optional() }).strict();
const portableManifest = z.object({
  $schema: z.literal(pluginSchemaId), name: z.string().min(1).max(64).regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
  version: z.string().optional(), description: z.string().optional(), author: metadata.optional(),
  homepage: z.string().optional(), repository: z.string().optional(), license: z.string().optional(),
  keywords: z.array(z.string()).optional(), extensions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
}).strict();
const portableMcp = z.object({
  $schema: z.literal(mcpSchemaId), mcpServers: z.record(z.string(), z.object({ type: z.literal('streamable-http'), url: z.string().min(1) }).strict()),
}).strict();

/** Only explicit concrete origins; portable remote URLs do not interpolate variables. */
export function pluginOrigin(value: string): string {
  if (!value || /[${}\s]/.test(value)) throw new Error('--origin must be an explicit concrete service origin, without placeholders or whitespace.');
  const url = new URL(value);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('--origin must not contain a path, credentials, query or fragment.');
  return serviceOrigin(value);
}

export function validatePortablePlugin(manifest: unknown, mcp: unknown): void {
  portableManifest.parse(manifest);
  const parsed = portableMcp.parse(mcp);
  if (Object.keys(parsed.mcpServers).length !== 1 || !parsed.mcpServers[pluginName]) throw new Error('The package must declare exactly the dovspace-pm connection.');
  for (const server of Object.values(parsed.mcpServers)) {
    const url = new URL(server.url);
    if (url.pathname !== '/mcp' || server.url !== `${pluginOrigin(url.origin)}/mcp` || /[${}]/.test(server.url)) throw new Error('Invalid concrete MCP URL.');
  }
}

export const CLIENT_BASELINE = {
  recordedAt: '2026-11-10', spec: 'Agent Plugins 1.0.0', verification: 'Executable versions measured by parent under isolated HOME; loading, OAuth and business acceptance remain separate.',
  measurementSource: 'parent isolated-HOME executable --version observations',
  clients: {
    codex: { documentationVersion: '0.167.0', measuredVersion: '0.166.0', surface: 'CLI native MCP + shared Skills; desktop portable marketplace is separate', versionCommand: ['codex', '--version'], discoverCommand: ['codex', 'mcp', 'list'], source: 'https://github.com/openai/codex/releases/tag/rust-v0.166.0' },
    claude: { documentationVersion: '2.1.281', measuredVersion: '2.1.303', surface: 'Claude Code native plugin', versionCommand: ['claude', '--version'], validateCommand: ['claude', 'plugin', 'validate', '--strict'], source: 'https://code.claude.com/docs/en/plugins/manifest-reference' },
    opencode: { documentationVersion: '2.1.2', measuredVersion: '2.1.2', surface: 'OpenCode 2.x native mcp.servers + shared Skills; isolated standalone TUI', versionCommand: ['opencode', '--version'], loadCommand: ['opencode', '--standalone'], source: 'https://github.com/anomalyco/opencode/tree/v2.1.2' },
    pi: { documentationVersion: '1.5.1', measuredVersion: '1.1.0', compatibleHostRange: '^1.1.0', surface: 'Pi native MCP registration and OAuth; trusted first-party extension', versionCommand: ['pi', '--version'], discoverCommand: '/mcp inside Pi; shell commands do not load extensions', source: 'https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/extensions.md' },
  },
};

async function regularText(filename: string): Promise<string> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw new Error(`Not a bounded regular file: ${filename}`);
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

/** All adapters consume this one authoring source and the existing application registry. */
export async function generatePluginFiles(originValue: string): Promise<Map<string, string>> {
  const origin = pluginOrigin(originValue), url = `${origin}/mcp`;
  const manifest = portableManifest.parse(JSON.parse(await regularText(path.join(sourceRoot, 'plugin.json'))));
  const mcp = { $schema: mcpSchemaId, mcpServers: { [pluginName]: { type: 'streamable-http', url } } };
  validatePortablePlugin(manifest, mcp);
  const resources = new Map<string, string>([
    ['plugin.json', json(manifest)], ['mcp.json', json(mcp)],
    ['LICENSE', await regularText(path.join(sourceRoot, 'LICENSE'))],
    ['README.md', await regularText(path.join(sourceRoot, 'README.md'))],
    ['capabilities.json', json(pluginCapabilities())],
  ]);
  const skillsDirectory = path.join(sourceRoot, 'skills');
  if (!(await lstat(skillsDirectory)).isDirectory() || (await lstat(skillsDirectory)).isSymbolicLink()) throw new Error('Unsafe skills source.');
  for (const entry of (await readdir(skillsDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!entry.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) throw new Error('Invalid skill directory in source.');
    const skill = await regularText(path.join(skillsDirectory, entry.name, 'SKILL.md'));
    if (!skill.startsWith(`---\nname: ${entry.name}\n`) || !/\ndescription: .{1,1024}\n/.test(skill)) throw new Error('Invalid Skill source metadata.');
    resources.set(`skills/${entry.name}/SKILL.md`, skill);
  }
  const files = new Map<string, string>();
  for (const prefix of ['portable', 'codex/plugin', 'claude', 'pi']) {
    for (const [filename, content] of resources) files.set(`${prefix}/${filename}`, content);
  }
  const nativeManifest = { name: manifest.name, version: manifest.version, description: manifest.description, author: manifest.author, license: manifest.license, keywords: manifest.keywords };
  const nativeMcp = { mcpServers: { [pluginName]: { type: 'http', url } } };
  files.set('claude/.claude-plugin/plugin.json', json(nativeManifest));
  files.set('claude/.mcp.json', json(nativeMcp));
  files.set('codex/plugin/.codex-plugin/plugin.json', json({ ...nativeManifest, skills: './skills/', mcpServers: './.mcp.json' }));
  files.set('codex/plugin/.mcp.json', json(nativeMcp));
  files.set('codex/.agents/plugins/marketplace.json', json({ name: pluginName, plugins: [{ name: pluginName, source: { source: 'local', path: './plugin' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }));
  files.set('codex/mcp.toml', `[mcp_servers.dovspace_pm]\nurl = ${JSON.stringify(url)}\n`);
  files.set('opencode/opencode.json', json({ $schema: 'https://opencode.ai/config.json', mcp: { servers: { [pluginName]: { type: 'remote', url, codemode: false } } } }));
  files.set('pi/package.json', json({ name: pluginName, version: manifest.version, type: 'module', license: manifest.license, keywords: ['pi-package'], pi: { extensions: ['./index.ts'], skills: ['./skills'] }, peerDependencies: { '@earendil-works/pi-coding-agent': '^1.1.0' } }));
  files.set('pi/index.ts', `import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';\n\nexport default function (pi: ExtensionAPI) {\n  pi.registerMcpServer(${JSON.stringify(pluginName)}, { url: ${JSON.stringify(url)}, exposure: 'direct' });\n  pi.on('session_start', async (_event, ctx) => { ctx.ui.notify(${JSON.stringify(PLUGIN_POLICY_NOTICE)}, 'info'); });\n}\n`);
  for (const [filename, content] of resources) {
    if (filename.startsWith('skills/')) {
      files.set(`codex/.agents/${filename}`, content);
      files.set(`opencode/.opencode/${filename}`, content);
    }
  }
  files.set('opencode/LICENSE', resources.get('LICENSE')!);
  files.set('opencode/README.md', resources.get('README.md')!);
  files.set('clients.json', json(CLIENT_BASELINE));
  files.set('connection.json', json({ plugin: pluginName, version: manifest.version, origin, mcpUrl: url, policy: PLUGIN_OPERATION_POLICY, notice: PLUGIN_POLICY_NOTICE }));
  files.set('LICENSE', resources.get('LICENSE')!);
  files.set('README.md', resources.get('README.md')!);
  return new Map([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function relativeFile(value: string): boolean {
  return value.length > 0 && !value.includes('\\') && !value.includes('\0') && !path.posix.isAbsolute(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..') && value !== ownerFile;
}

type Ownership = { schemaVersion: 1; plugin: 'dovspace-pm'; files: Record<string, string> };
const ownershipSchema = z.object({ schemaVersion: z.literal(1), plugin: z.literal('dovspace-pm'), files: z.record(z.string().refine(relativeFile), z.string().regex(/^[a-f0-9]{64}$/)) }).strict();

async function treeFiles(directory: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Managed packages must not contain symlinks.');
    if (entry.isDirectory()) result.push(`${relative}/`, ...await treeFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) result.push(relative);
    else throw new Error('Managed packages must contain only regular files and directories.');
  }
  return result.sort();
}

async function verifyOwned(directory: string): Promise<Ownership> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refusing an unowned package path.');
  const ownership = ownershipSchema.parse(JSON.parse(await regularText(path.join(directory, ownerFile))));
  const directories = new Set<string>();
  for (const filename of Object.keys(ownership.files)) {
    let parent = path.posix.dirname(filename);
    while (parent !== '.') { directories.add(`${parent}/`); parent = path.posix.dirname(parent); }
  }
  const actual = await treeFiles(directory), expected = [...Object.keys(ownership.files), ...directories, ownerFile].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Package has unowned files; no existing content was removed.');
  for (const [filename, hash] of Object.entries(ownership.files)) {
    if (digest(await regularText(path.join(directory, filename))) !== hash) throw new Error(`Package was modified: ${filename}; preserve it before update/uninstall.`);
  }
  return ownership;
}

async function removeOwned(directory: string): Promise<void> {
  const ownership = await verifyOwned(directory);
  const directories = new Set<string>();
  for (const [filename, hash] of Object.entries(ownership.files)) {
    // Recheck every file immediately before unlink. Do not recursively rm a user-editable tree.
    if (digest(await regularText(path.join(directory, filename))) !== hash) throw new Error('Package changed during removal.');
    await unlink(path.join(directory, filename));
    let parent = path.posix.dirname(filename);
    while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
  }
  for (const relative of [...directories].sort((a, b) => b.split('/').length - a.split('/').length)) await rmdir(path.join(directory, relative));
  await unlink(path.join(directory, ownerFile));
  await rmdir(directory);
}

async function exists(filename: string): Promise<boolean> {
  try { await lstat(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** A dedicated owned package only: never opens, merges or rewrites a client's existing config. */
export async function managePlugin(action: 'generate' | 'install' | 'update' | 'uninstall', rootValue: string, origin?: string) {
  if (!rootValue || !path.isAbsolute(rootValue)) throw new Error('--root must be an explicit absolute private installation directory.');
  const root = path.resolve(rootValue);
  await privateDirectory(root, false).then(found => { if (!found) throw new Error('--root must already exist as an owned private directory.'); });
  const target = path.join(root, pluginName), lock = path.join(root, '.dovspace-pm.install-lock');
  await mkdir(lock, { mode: 0o700 }); // EEXIST is a conflict, never a reason to delete an unknown lock.
  let staged: string | undefined;
  let backup: string | undefined;
  try {
    const present = await exists(target);
    if (action === 'uninstall') {
      if (!present) return { status: 'not-installed', target, notice: PLUGIN_POLICY_NOTICE };
      await removeOwned(target);
      return { status: 'uninstalled', target, notice: PLUGIN_POLICY_NOTICE };
    }
    const files = await generatePluginFiles(origin ?? '');
    if (action === 'update') { if (!present) throw new Error('Update requires an existing owned package.'); await verifyOwned(target); }
    else if (present) throw new Error('Target exists; use update for an unchanged owned package.');
    staged = await mkdtemp(path.join(root, '.dovspace-pm-stage-'));
    const ownership: Ownership = { schemaVersion: 1, plugin: pluginName, files: Object.fromEntries([...files].map(([filename, content]) => [filename, digest(content)])) };
    // Write ownership first so interrupted staging remains identifiable, never an arbitrary rm target.
    await writeFile(path.join(staged, ownerFile), json(ownership), { flag: 'wx', mode: 0o600 });
    for (const [filename, content] of files) {
      await mkdir(path.dirname(path.join(staged, filename)), { recursive: true, mode: 0o700 });
      await writeFile(path.join(staged, filename), content, { flag: 'wx', mode: 0o600 });
    }
    await verifyOwned(staged);
    if (present) {
      await verifyOwned(target);
      backup = path.join(root, `.dovspace-pm-backup-${randomUUID()}`);
      await rename(target, backup);
    }
    try {
      await rename(staged, target);
      staged = undefined;
    } catch (error) {
      if (backup) { await rename(backup, target); backup = undefined; }
      throw error;
    }
    if (backup) { await removeOwned(backup); backup = undefined; }
    return { status: action === 'update' ? 'updated' : action === 'generate' ? 'generated' : 'installed', target, files: files.size, notice: PLUGIN_POLICY_NOTICE };
  } catch (error) {
    // Partial staging is retained if its complete ownership cannot be verified, never force-deleted.
    if (staged && await exists(staged)) await removeOwned(staged).catch(() => undefined);
    if (backup) throw new Error(`Update preserved the original package at ${backup}; no client configuration was changed. ${error instanceof Error ? error.message : 'Update failed.'}`);
    throw error;
  } finally { await rmdir(lock); }
}
