import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { generatePluginFiles, managePlugin, pluginOrigin, validatePortablePlugin, PLUGIN_POLICY_NOTICE } from '../plugin-distribution.ts';
import { pluginCapabilities, PLUGIN_OPERATION_POLICY } from '../plugin-capabilities.ts';
import { AGENT_CHAT_TOOL_REGISTRY, agentChatToolDefinitions } from '../../application/src/agent-chat-tools.ts';

async function fixture() {
  const parent = await realpath(process.platform === 'win32' ? tmpdir() : '/tmp');
  return await mkdtemp(path.join(parent, 'dovspace-plugin-'));
}

const origin = 'http://127.0.0.1:3224';

test('explicit plugin origins reject interpolation, embedded credentials and insecure remote HTTP', () => {
  assert.equal(pluginOrigin('https://PM.EXAMPLE.invalid:443/'), 'https://pm.example.invalid');
  assert.equal(pluginOrigin(origin), origin);
  for (const value of ['', '${DOVSPACE_URL}', 'https://${HOST}', 'http://remote.invalid', 'http://127.0.0.1.remote.invalid', 'https://user:secret@pm.invalid', `${origin}/mcp`, `${origin}?token=secret`, `${origin}#secret`, ' https://pm.invalid']) {
    assert.throws(() => pluginOrigin(value));
  }
});

test('one registry exports every tool schema and existing capability without a second operation ACL', () => {
  const capabilities = pluginCapabilities();
  assert.deepEqual(capabilities.policy, { access: 'full', enforcement: 'audit-only', interactiveOperationPermission: false });
  assert.deepEqual(capabilities.tools.map(tool => tool.name), AGENT_CHAT_TOOL_REGISTRY.map(tool => tool.name));
  for (const tool of capabilities.tools) {
    assert.deepEqual(tool.capabilities, AGENT_CHAT_TOOL_REGISTRY.find(item => item.name === tool.name)!.capabilities);
    assert.deepEqual(tool.inputSchema, agentChatToolDefinitions.find(item => item.function.name === tool.name)!.function.parameters);
    assert.equal(tool.availability, 'runtime-discovery-required');
    assert.equal(tool.permissionSource, 'existing-pm-capabilities');
  }
  assert.equal(capabilities.gatewayControls.recovery.redispatch, false);
  assert.equal(capabilities.gatewayControls.traceAuthority, 'server');
  assert.ok(capabilities.resultSchema && capabilities.projectionSchema);
});

test('generation is deterministic, schema-compatible, credential-free and uses identical shared Skills', async () => {
  const first = await generatePluginFiles(origin), second = await generatePluginFiles(origin);
  assert.deepEqual([...first], [...second]);
  const manifest = JSON.parse(first.get('portable/plugin.json')!);
  const mcp = JSON.parse(first.get('portable/mcp.json')!);
  validatePortablePlugin(manifest, mcp);
  assert.deepEqual(mcp.mcpServers['dovspace-pm'], { type: 'streamable-http', url: `${origin}/mcp` });
  assert.throws(() => validatePortablePlugin({ ...manifest, permissions: ['full'] }, mcp));
  assert.throws(() => validatePortablePlugin(manifest, { ...mcp, mcpServers: { 'dovspace-pm': { type: 'streamable-http', url: `${origin}/mcp`, headers: { Authorization: 'Bearer forbidden' } } } }));
  const connection = JSON.parse(first.get('connection.json')!);
  assert.deepEqual(connection.policy, PLUGIN_OPERATION_POLICY);
  assert.equal(connection.notice, PLUGIN_POLICY_NOTICE);
  const portableSkills = [...first].filter(([filename]) => filename.startsWith('portable/skills/'));
  assert.equal(portableSkills.length, 3);
  for (const [filename, content] of portableSkills) {
    const skillPath = filename.slice('portable/'.length);
    for (const prefix of ['codex/plugin', 'claude', 'pi', 'codex/.agents', 'opencode/.opencode']) assert.equal(first.get(`${prefix}/${skillPath}`), content);
  }
  assert.match(first.get('portable/LICENSE')!, /GNU AFFERO GENERAL PUBLIC LICENSE/);
  const claude = JSON.parse(first.get('claude/.mcp.json')!);
  assert.deepEqual(claude.mcpServers['dovspace-pm'], { type: 'http', url: `${origin}/mcp` });
  const openCode = JSON.parse(first.get('opencode/opencode.json')!);
  const nativeMcp = z.object({
    $schema: z.literal('https://opencode.ai/config.json'),
    mcp: z.object({
      servers: z.record(z.string(), z.object({ type: z.literal('remote'), url: z.url(), codemode: z.literal(false) }).strict()),
    }).strict(),
  }).strict().parse(openCode);
  assert.deepEqual(Object.keys(nativeMcp.mcp.servers), ['dovspace-pm']);
  assert.equal(nativeMcp.mcp.servers['dovspace-pm']!.url, `${origin}/mcp`);
  assert.equal('dovspace-pm' in openCode.mcp, false);
  assert.equal('enabled' in nativeMcp.mcp.servers['dovspace-pm']!, false);
  assert.equal(openCode.permissions, undefined);
  assert.equal(openCode.policies, undefined);
  assert.match(first.get('pi/index.ts')!, /pi\.registerMcpServer\("dovspace-pm"/);
  assert.doesNotMatch(first.get('pi/index.ts')!, /registerTool|confirm\(|\.select\(|readFile|process\.env|Authorization|fetch\(/);
  assert.doesNotMatch(first.get('codex/mcp.toml')!, /approval|bearer|headers/);
  assert.equal(JSON.parse(first.get('claude/.claude-plugin/plugin.json')!).userConfig, undefined);
});

test('measured client versions remain distinct from documentation targets and native OpenCode2 needs no legacy adapter', async () => {
  const files = await generatePluginFiles('https://confirmed.example.invalid');
  const clients = JSON.parse(files.get('clients.json')!);
  assert.match(clients.measurementSource, /parent isolated-HOME/);
  assert.equal(clients.clients.codex.measuredVersion, '0.166.0');
  assert.equal(clients.clients.codex.documentationVersion, '0.167.0');
  assert.equal(clients.clients.claude.measuredVersion, '2.1.303');
  assert.equal(clients.clients.pi.measuredVersion, '1.1.0');
  assert.equal(clients.clients.pi.compatibleHostRange, '^1.1.0');
  const piPackage = JSON.parse(files.get('pi/package.json')!);
  assert.equal(piPackage.peerDependencies['@earendil-works/pi-coding-agent'], '^1.1.0');
  assert.deepEqual(piPackage.pi.extensions, ['./index.ts']);
  assert.deepEqual(piPackage.pi.skills, ['./skills']);
  assert.equal(piPackage.dependencies, undefined);
  assert.equal(clients.clients.opencode.measuredVersion, '2.1.2');
  const config = JSON.parse(files.get('opencode/opencode.json')!);
  assert.equal(config.mcp.servers['dovspace-pm'].url, 'https://confirmed.example.invalid/mcp');
  assert.equal(config.mcp.servers['dovspace-pm'].codemode, false);
  assert.equal(Object.keys(config.mcp).length, 1);
  assert.equal(files.has('opencode-v1/opencode.json'), false);
  assert.equal(files.has('opencode-v2/opencode.json'), false);
  assert.equal(files.get('opencode/LICENSE'), files.get('portable/LICENSE'));
  for (const skill of ['project-management', 'issue-management', 'task-planning']) {
    assert.equal(files.get(`opencode/.opencode/skills/${skill}/SKILL.md`), files.get(`portable/skills/${skill}/SKILL.md`));
  }
});

test('owned install/update/uninstall preserves unrelated configs and publishes the observable full/audit-only notice', async () => {
  const root = await fixture();
  try {
    const config = '{"permissions":{"existing":"ask"},"otherServer":true}\n';
    await writeFile(path.join(root, 'existing-client.json'), config, { mode: 0o600 });
    const installed = await managePlugin('install', root, origin);
    assert.equal(installed.status, 'installed');
    assert.match(installed.notice, /full access \/ audit-only/);
    const target = path.join(root, 'dovspace-pm');
    assert.equal((await stat(path.join(target, 'portable/mcp.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(target, 'pi'))).mode & 0o777, 0o700);
    await assert.rejects(managePlugin('install', root, origin), /Target exists/);
    const updated = await managePlugin('update', root, 'https://confirmed.example.invalid');
    assert.equal(updated.status, 'updated');
    assert.equal(JSON.parse(await readFile(path.join(target, 'connection.json'), 'utf8')).origin, 'https://confirmed.example.invalid');
    assert.equal(await readFile(path.join(root, 'existing-client.json'), 'utf8'), config);
    assert.equal((await managePlugin('uninstall', root)).status, 'uninstalled');
    assert.deepEqual(await readdir(root), ['existing-client.json']);
    assert.equal((await managePlugin('uninstall', root)).status, 'not-installed');
    assert.equal(await readFile(path.join(root, 'existing-client.json'), 'utf8'), config);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed update and owned-file drift preserve the prior package and never remove unowned contents', async () => {
  const root = await fixture();
  try {
    await managePlugin('generate', root, origin);
    const target = path.join(root, 'dovspace-pm');
    const original = await readFile(path.join(target, 'connection.json'), 'utf8');
    await assert.rejects(managePlugin('update', root, 'http://remote.invalid'));
    assert.equal(await readFile(path.join(target, 'connection.json'), 'utf8'), original);
    await writeFile(path.join(target, 'private-user-notes'), 'DO NOT DELETE');
    await assert.rejects(managePlugin('update', root, origin), /unowned files/);
    await assert.rejects(managePlugin('uninstall', root), /unowned files/);
    assert.equal(await readFile(path.join(target, 'private-user-notes'), 'utf8'), 'DO NOT DELETE');
    assert.equal(await readFile(path.join(target, 'connection.json'), 'utf8'), original);
    await rm(path.join(target, 'private-user-notes'));
    await writeFile(path.join(target, 'connection.json'), 'user edit');
    await assert.rejects(managePlugin('update', root, origin), /modified/);
    await assert.rejects(managePlugin('uninstall', root), /modified/);
    assert.equal(await readFile(path.join(target, 'connection.json'), 'utf8'), 'user edit');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unexpected empty directories, links and locks are blocking filesystem trust boundaries, not new operation permissions', async () => {
  const root = await fixture();
  try {
    await managePlugin('install', root, origin);
    const target = path.join(root, 'dovspace-pm');
    await mkdir(path.join(target, 'unowned-empty'));
    await assert.rejects(managePlugin('uninstall', root), /unowned files/);
    assert.ok(await readFile(path.join(target, 'portable/plugin.json'), 'utf8'));
    await rm(path.join(target, 'unowned-empty'), { recursive: true });
    await symlink(path.join(root, 'external'), path.join(target, 'escape'));
    await assert.rejects(managePlugin('update', root, origin), /symlinks/);
    await rm(path.join(target, 'escape'));
    await link(path.join(target, 'portable/plugin.json'), path.join(root, 'linked-manifest'));
    await assert.rejects(managePlugin('uninstall', root), /regular file/);
    await rm(path.join(root, 'linked-manifest'));
    await mkdir(path.join(root, '.dovspace-pm.install-lock'));
    await assert.rejects(managePlugin('update', root, origin), { code: 'EEXIST' });
    await rm(path.join(root, '.dovspace-pm.install-lock'), { recursive: true });
    await chmod(root, 0o755);
    await assert.rejects(managePlugin('update', root, origin), /Private credential storage/);
  } finally { await chmod(root, 0o700); await rm(root, { recursive: true, force: true }); }
});
