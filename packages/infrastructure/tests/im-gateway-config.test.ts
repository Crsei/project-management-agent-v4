import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readImGatewayConfig } from '../src/im-gateway-config.ts';

async function privateToken(): Promise<{ directory: string; file: string; token: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'pm-im-token-'));
  const file = join(directory, 'satori-token');
  const token = 'A'.repeat(64);
  await writeFile(file, token, { mode: 0o600 });
  await chmod(file, 0o600);
  return { directory, file, token };
}

test('IM gateway configuration is disabled only when all connection values are absent', async () => {
  assert.equal(readImGatewayConfig({}), undefined);
  assert.throws(() => readImGatewayConfig({ IM_SATORI_WS_URL: 'ws://127.0.0.1:5140/satori' }), /incomplete/);
  const token = await privateToken();
  try {
    const config = readImGatewayConfig({
      IM_SATORI_WS_URL: 'ws://127.0.0.1:5140/satori/',
      IM_SATORI_API_URL: 'http://127.0.0.1:5140/satori',
      IM_SATORI_TOKEN_FILE: token.file,
      IM_PLATFORM_ALLOWLIST: 'telegram, telegram',
    });
    assert.deepEqual(config, {
      wsUrl: 'ws://127.0.0.1:5140/satori',
      apiUrl: 'http://127.0.0.1:5140/satori',
      token: token.token,
      platforms: ['telegram'],
      timeoutMs: 10_000,
      linkTtlSeconds: 300,
      gatewayId: 'default',
      botUsername: null,
    });
  } finally { await rm(token.directory, { recursive: true, force: true }); }
});

test('IM gateway configuration rejects public cleartext and non-private token files', async () => {
  const token = await privateToken();
  try {
    assert.throws(() => readImGatewayConfig({
      IM_SATORI_WS_URL: 'ws://example.com/satori',
      IM_SATORI_API_URL: 'http://127.0.0.1:5140/satori',
      IM_SATORI_TOKEN_FILE: token.file,
    }), /Invalid IM_SATORI_WS_URL/);
    assert.throws(() => readImGatewayConfig({
      IM_SATORI_WS_URL: 'ws://127.0.0.1:5140/satori',
      IM_SATORI_API_URL: 'http://127.0.0.1:5140/satori',
      IM_SATORI_TOKEN_FILE: token.file,
      IM_PLATFORM_ALLOWLIST: 'Telegram',
    }), /IM_PLATFORM_ALLOWLIST/);
    await chmod(token.file, 0o644);
    assert.throws(() => readImGatewayConfig({
      IM_SATORI_WS_URL: 'ws://127.0.0.1:5140/satori',
      IM_SATORI_API_URL: 'http://127.0.0.1:5140/satori',
      IM_SATORI_TOKEN_FILE: token.file,
    }), /private|permissions/i);
  } finally {
    await chmod(token.file, 0o600).catch(() => undefined);
    await rm(token.directory, { recursive: true, force: true });
  }
});
