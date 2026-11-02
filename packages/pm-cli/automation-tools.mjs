#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

// This executable receives a path, never a secret in argv/environment or a model prompt.
const index = process.argv.indexOf('--grant-file');
const filename = index >= 0 ? process.argv[index + 1] : undefined;
if (!filename) throw new Error('A generation-private integration grant file is required.');
const stat = await lstat(filename);
if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 16384) throw new Error('Unsafe integration grant file.');
let grant;
let url;
try {
  grant = JSON.parse(await readFile(filename, 'utf8')); url = new URL(grant.url);
  if (grant.schemaVersion !== 1 || typeof grant.token !== 'string' || !grant.executionId || !grant.generationId || !Number.isFinite(grant.expiresAt) || url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('invalid');
} catch { throw new Error('Invalid scoped integration grant; private contents are withheld.'); }
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
for await (const line of input) {
  if (!line.trim()) continue;
  let message;
  try { if (Buffer.byteLength(line) > 1048576) throw new Error('Request is too large'); message = JSON.parse(line); }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid bounded JSON request' } }); continue; }
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Expected a JSON-RPC 2.0 object' } }); continue; }
  if (!Object.hasOwn(message, 'id')) continue;
  try {
    if (message.method === 'initialize') { send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'pm-automation-integrations', version: '1' } } }); continue; }
    if (message.method === 'ping') { send({ jsonrpc: '2.0', id: message.id, result: {} }); continue; }
    if (!['tools/list', 'tools/call'].includes(message.method)) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Only execution-scoped integration tools are exposed' } }); continue; }
    if (Date.now() >= grant.expiresAt) throw new Error('Native generation integration grant expired');
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${grant.token}` }, body: JSON.stringify({ executionId: grant.executionId, generationId: grant.generationId, method: message.method, params: message.params ?? {} }), redirect: 'error', signal: AbortSignal.timeout(60000) });
    const text = await response.text();
    if (Buffer.byteLength(text) > 4194304) throw new Error('Broker response exceeded the transport bound');
    const result = JSON.parse(text);
    if (!response.ok) throw new Error(result?.error?.message ?? `Scoped integration operation failed (HTTP ${response.status})`);
    send({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Scoped integration operation failed; reconcile the original operation UUID' } }); }
}
