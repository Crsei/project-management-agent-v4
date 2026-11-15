import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, rm, watch, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BenchEvent, FixtureHandle } from '../schemas/types.ts';
import { collectSourceManifest } from '../isolation/source.ts';
import { fixturePmToken, parseCliRecords, ProductCliProcess } from './product-cli-process.ts';

// Deliberately a subprocess peer, not an implementation or a claim of product acceptance.
async function peer(source: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-cli-process-'));
  const stage = path.join(root, 'source');
  for (const name of ['apps/server', 'apps/desktop/src', 'packages/pm-cli', 'vendor']) await mkdir(path.join(stage, name), { recursive: true, mode: 0o700 });
  for (const name of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json']) await writeFile(path.join(stage, name), name.endsWith('.json') ? '{"type":"module"}' : '', { mode: 0o400 });
  await writeFile(path.join(stage, 'packages/pm-cli/index.ts'), source, { mode: 0o400 });
  await writeFile(path.join(stage, 'apps/desktop/src/private-state.mjs'), 'export const fixtureMarker = "no-desktop-execution";', { mode: 0o400 });
  const manifest = await collectSourceManifest(stage);
  const token = 'p'.repeat(43);
  const fixture = {
    root, workspaceId: 'workspace', productSource: { root: stage, manifest }, pm: { baseUrl: 'http://127.0.0.1:3902', token: `pm_v4_session=${token}` },
    runtime: { agentBaseUrl: 'http://127.0.0.1:3903', agentAccessToken: 'a'.repeat(43), pmCookie: `pm_v4_session=${token}`, environmentEvidence: { sourceHash: manifest.sourceHash }, providerConfig: { environment: [], config: {} } },
  } as unknown as FixtureHandle;
  const events: BenchEvent[] = [];
  const cli = await ProductCliProcess.open('run', fixture, event => events.push(event));
  return { root, stage, fixture, cli, events };
}

test('PM fixture Cookie is converted to the exact native token, never accepted as arbitrary authority', () => {
  const token = 'P'.repeat(43);
  assert.equal(fixturePmToken(`pm_v4_session=${token}`), token);
  for (const cookie of [token, `agent_v4_access=${token}`, `pm_v4_session=${token}; other=secret`, 'pm_v4_session=short']) assert.throws(() => fixturePmToken(cookie));
});

test('pretty CLI projections preserve nested strings and reject partial or non-JSON acceptance', () => {
  const records = [{ kind: 'stream-open', generationId: 'original' }, { kind: 'native', event: { text: 'literal } [ \\" quote', items: [{ value: 'x' }] } }];
  assert.deepEqual(parseCliRecords(records.map(record => JSON.stringify(record, null, 2)).join('\n')), records);
  assert.throws(() => parseCliRecords('{"kind":"stream-open"}\n{"kind":'), /mid-projection/);
  assert.throws(() => parseCliRecords('accepted!'), /object projection/);
});

test('child gets a private HOME, clean environment, token stdin and protected request file without secret argv', async () => {
  const fixture = await peer(`import { readFile, stat } from 'node:fs/promises';
let stdin = ''; for await (const part of process.stdin) stdin += part;
const filename = process.argv[process.argv.indexOf('--file') + 1];
console.log(JSON.stringify({ home: process.env.HOME, cwd: process.cwd(), secretInherited: process.env.DOVSPACE_CLI_TEST_AMBIENT ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, envKeys: Object.keys(process.env), argv: process.argv, stdin, payload: JSON.parse(await readFile(filename, 'utf8')), mode: (await stat(filename)).mode & 511, pmToken: process.env.PM_SESSION_TOKEN }));`);
  const old = process.env.DOVSPACE_CLI_TEST_AMBIENT;
  process.env.DOVSPACE_CLI_TEST_AMBIENT = 'must-not-cross';
  try {
    const result = await fixture.cli.run(['agent', 'message', 'send', 'original-session'], { stdin: 'private-agent-token', file: { text: 'private request' } });
    assert.equal(result.outcome, 'completed');
    const record = result.records[0]!;
    assert.equal(record.secretInherited, null); assert.equal(record.nodeOptions, null);
    assert.equal(record.home, record.cwd); assert.notEqual(record.home, process.env.HOME);
    assert.equal((await lstat(String(record.home))).mode & 0o777, 0o700);
    assert.equal(record.mode, 0o600); assert.deepEqual(record.payload, { text: 'private request' });
    assert.equal(record.pmToken, 'p'.repeat(43)); assert.equal(record.stdin, 'private-agent-token');
    assert.equal(JSON.stringify(record.argv).includes('private-agent-token'), false);
    assert.equal(JSON.stringify(record.argv).includes('private request'), false);
    assert.equal((record.argv as string[])[1], path.join(fixture.stage, 'packages/pm-cli/index.ts'));
    assert.equal(JSON.stringify(fixture.events).includes('private request'), false);
    assert.deepEqual(fixture.events[0]!.data.command, ['agent', 'message', 'send']);
    await fixture.cli.dispose();
    await assert.rejects(lstat(String(record.home)), { code: 'ENOENT' });
    await assert.rejects(fixture.cli.run(['agent', 'status']), /disposed/);
  } finally {
    if (old === undefined) delete process.env.DOVSPACE_CLI_TEST_AMBIENT; else process.env.DOVSPACE_CLI_TEST_AMBIENT = old;
    await fixture.cli.dispose(); await rm(fixture.root, { recursive: true, force: true });
  }
});

test('finite timeout kills the owned child group and preserves unknown rather than successful acceptance', async () => {
  // This deliberately tests the OS child deadline: fake timers cannot control the separate Node process.
  const fixture = await peer(`process.stdin.resume(); console.log(JSON.stringify({ kind: 'stream-open', generationId: 'original' })); setInterval(() => {}, 1000);`);
  try {
    const result = await fixture.cli.run(['agent', 'message', 'send', 'original-session'], { timeoutMs: 1000 });
    assert.equal(result.outcome, 'unknown'); assert.equal(result.exitCode, null);
    assert.ok(result.durationMs >= 900); assert.ok(result.durationMs < 10_000);
    assert.equal(fixture.events.length, 1); assert.equal(fixture.events[0]!.data.outcome, 'unknown');
  } finally { await fixture.cli.dispose(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('source mutation and service source-identity mismatch fail before child dispatch', async () => {
  const fixture = await peer(`console.log(JSON.stringify({ dispatched: true }));`);
  try {
    fixture.fixture.runtime!.environmentEvidence.sourceHash = '0'.repeat(64);
    await assert.rejects(ProductCliProcess.open('run', fixture.fixture, () => {}), /source identity/);
    await chmod(path.join(fixture.stage, 'packages/pm-cli/index.ts'), 0o600);
    await writeFile(path.join(fixture.stage, 'packages/pm-cli/index.ts'), 'throw new Error("must never execute");');
    await assert.rejects(fixture.cli.run(['agent', 'status']), /CLI bytes changed/);
    assert.equal(fixture.events.length, 0);
  } finally { await fixture.cli.dispose(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('dispose waits for active child and private input cleanup before deleting HOME', async () => {
  const fixture = await peer(`if (process.argv[3] === 'status') console.log(JSON.stringify({ home: process.env.HOME })); else { process.stdin.resume(); setInterval(() => {}, 1000); }`);
  try {
    const status = await fixture.cli.run(['agent', 'status']);
    const privateHome = String(status.records[0]!.home);
    const watcher = watch(privateHome);
    const inputCreated = (async () => {
      for await (const event of watcher) if (event.eventType === 'rename') return;
      throw new Error('Private input watcher closed before dispatch.');
    })();
    const running = fixture.cli.run(['agent', 'message', 'send', 'original-session'], { file: { private: 'request' }, timeoutMs: 5000 })
      .then(result => ({ result }), error => ({ error }));
    // Synchronize on a real filesystem event; disposal also covers the pre-spawn race.
    await inputCreated;
    await fixture.cli.dispose();
    const settled = await running;
    if ('error' in settled) assert.match(String(settled.error), /disposed/);
    else assert.equal(settled.result.outcome, 'unknown');
    await assert.rejects(lstat(privateHome), { code: 'ENOENT' });
  } finally { await fixture.cli.dispose(); await rm(fixture.root, { recursive: true, force: true }); }
});
