import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assertPrivatePath } from '../../pm-core/private-path.ts';

export type ImGatewayConfig = {
  /** Satori server base, for example ws://127.0.0.1:5140/satori. */
  wsUrl: string;
  /** Satori HTTP base, for example http://127.0.0.1:5140/satori. */
  apiUrl: string;
  /** Shared Satori server token. Never log this value. */
  token: string;
  platforms: string[];
  timeoutMs: number;
  linkTtlSeconds: number;
  /** Stable deployment identity for external account mappings. */
  gatewayId: string;
  /** Optional Telegram bot username used to build a t.me link in the UI. */
  botUsername: string | null;
};

const LOOPBACK_HOSTS: Record<string, true> = { '127.0.0.1': true, localhost: true, '[::1]': true, '::1': true };
const PLATFORM = /^[a-z][a-z0-9_-]{1,39}$/;

function normalizeBase(input: string, protocols: readonly string[], name: string): string {
  if (!input || /[\u0000-\u0020\u007f\\%]/.test(input)) throw new Error(`Invalid ${name}`);
  const url = new URL(input);
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`Invalid ${name}`);
  if (url.pathname.split('/').some(segment => segment === '..' || segment === '.')) throw new Error(`Invalid ${name}`);
  if ((url.protocol === 'ws:' || url.protocol === 'http:') && LOOPBACK_HOSTS[url.hostname.toLowerCase()] !== true) throw new Error(`Invalid ${name}`);
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href.replace(/\/$/, '');
}

function readToken(filename: string): string {
  if (!filename || !path.isAbsolute(filename)) throw new Error('IM token file must be an absolute path');
  assertPrivatePath(filename);
  const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 32 || stat.size > 256 || stat.mode & 0o077) throw new Error('IM token file is not private');
    const token = readFileSync(descriptor, 'utf8').trim();
    if (!/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error('IM token file is invalid');
    return token;
  } finally { closeSync(descriptor); }
}

/** All three connection values are required together; absence means the feature is disabled. */
export function readImGatewayConfig(env: NodeJS.ProcessEnv = process.env): ImGatewayConfig | undefined {
  const required = ['IM_SATORI_WS_URL', 'IM_SATORI_API_URL', 'IM_SATORI_TOKEN_FILE'] as const;
  const present = required.filter(key => Boolean(env[key]));
  if (!present.length) return undefined;
  if (present.length !== required.length) throw new Error('IM gateway configuration is incomplete');
  const wsUrl = normalizeBase(env.IM_SATORI_WS_URL!, ['ws:', 'wss:'], 'IM_SATORI_WS_URL');
  const apiUrl = normalizeBase(env.IM_SATORI_API_URL!, ['http:', 'https:'], 'IM_SATORI_API_URL');
  const platforms = [...new Set((env.IM_PLATFORM_ALLOWLIST ?? 'telegram').split(',').map(value => value.trim()).filter(Boolean))];
  if (!platforms.length || platforms.some(platform => !PLATFORM.test(platform))) throw new Error('IM_PLATFORM_ALLOWLIST is invalid');
  const timeout = Number(env.IM_DELIVERY_TIMEOUT_MS ?? 10_000);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 60_000) throw new Error('IM_DELIVERY_TIMEOUT_MS is invalid');
  const linkTtl = Number(env.IM_LINK_TTL_SECONDS ?? 300);
  if (!Number.isInteger(linkTtl) || linkTtl < 300 || linkTtl > 900) throw new Error('IM_LINK_TTL_SECONDS is invalid');
  const gatewayId = env.IM_GATEWAY_ID ?? 'default';
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(gatewayId)) throw new Error('IM_GATEWAY_ID is invalid');
  const rawBotUsername = env.IM_BOT_USERNAME?.trim().replace(/^@/, '') ?? '';
  if (rawBotUsername && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(rawBotUsername)) throw new Error('IM_BOT_USERNAME is invalid');
  return {
    wsUrl, apiUrl, token: readToken(env.IM_SATORI_TOKEN_FILE!), platforms,
    timeoutMs: timeout, linkTtlSeconds: linkTtl, gatewayId,
    botUsername: rawBotUsername || null,
  };
}
