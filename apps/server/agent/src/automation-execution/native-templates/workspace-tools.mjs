#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

// A private grant path, never a credential in argv, environment or model context.
const position = process.argv.indexOf('--grant-file');
const filename = position >= 0 ? process.argv[position + 1] : undefined;
if (!filename) throw new Error('A native generation workspace grant file is required.');
const info = await lstat(filename);
if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > 16384) throw new Error('Unsafe native workspace grant file.');
const grant = JSON.parse(await readFile(filename, 'utf8'));
const url = new URL(grant.url);
if (grant.schemaVersion !== 1 || typeof grant.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(grant.token) || !grant.generationId || !Number.isFinite(grant.expiresAt) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash || !url.port) throw new Error('Invalid native workspace grant.');
const requests = new Map();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of lines) {
  if (!line.trim()) continue;
  let message;
  try { if (Buffer.byteLength(line) > 4194304) throw new Error('Request too large'); message = JSON.parse(line); if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('A JSON-RPC object is required'); }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid bounded JSON request' } }); continue; }
  if (!Object.hasOwn(message, 'id')) continue;
  try {
    if (message.method === 'initialize') { send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'pm-native-automation-workspace', version: '1' } } }); continue; }
    if (message.method === 'ping') { send({ jsonrpc: '2.0', id: message.id, result: {} }); continue; }
    if (!['tools/list', 'tools/call'].includes(message.method)) throw new Error('Only generation-scoped native workspace tools are exposed.');
    if (Date.now() >= grant.expiresAt) throw new Error('Native workspace grant expired.');
    let params = message.params ?? {};
    if (message.method === 'tools/call') {
      if (typeof params.name !== 'string' || !params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) throw new Error('Tool name and object arguments are required.');
      const key = JSON.stringify(message.id), fingerprint = JSON.stringify([params.name, params.arguments]);
      let request = requests.get(key);
      if (request && request.fingerprint !== fingerprint) throw new Error('MCP request identity was reused with different arguments.');
      if (!request) {
        const digest = createHash('sha256').update(`${grant.generationId}\n${key}`).digest();
        digest[6] = (digest[6] & 0x0f) | 0x50; digest[8] = (digest[8] & 0x3f) | 0x80;
        const hex = digest.toString('hex').slice(0, 32);
        request = { fingerprint, operationId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` };
        requests.set(key, request);
      }
      params = { name: params.name, arguments: params.arguments, operationId: request.operationId };
    }
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${grant.token}` }, body: JSON.stringify({ method: message.method, params }), redirect: 'error', signal: AbortSignal.timeout(330000) });
    const text = await response.text();
    if (Buffer.byteLength(text) > 5 * 1024 * 1024) throw new Error('Workspace response exceeded its transport bound.');
    const result = JSON.parse(text);
    if (!response.ok) throw new Error(result.error ?? 'Original workspace call failed; query its operation ID instead of repeating uncertain commands.');
    send({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Native workspace tool failed.' } }); }
}
