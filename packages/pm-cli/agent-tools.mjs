#!/usr/bin/env node
// Generation-scoped transport: no credentials are accepted or stored here.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const [base, group, action] = process.argv.slice(2);
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || !((group === 'tools' && ['list', 'call', 'result'].includes(action)) || group === 'mcp')) {
  console.error('Usage: node agent-tools.mjs http://127.0.0.1:PORT tools list|call|result (JSON stdin for call/result), or ... mcp');
  process.exit(2);
}
async function request(method, body) {
  const response = await fetch(`${base}/tools/${method}`, { method: method === 'list' ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
if (group === 'mcp') {
  const transportId = randomUUID();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let msg;
    try {
      msg = JSON.parse(line);
      if (!Object.hasOwn(msg, 'id')) continue;
      let result;
      if (msg.method === 'initialize') result = { protocolVersion: msg.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'pm-tools', version: '1.0.0' } };
      else if (msg.method === 'ping') result = {};
      else if (msg.method === 'tools/list') {
        const registry = await request('list');
        result = { tools: registry.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
      } else if (msg.method === 'tools/call') {
        const record = await request('mcp-call', { transportId, requestId: msg.id, name: msg.params.name, arguments: msg.params.arguments || {} });
        result = { content: [{ type: 'text', text: JSON.stringify(record) }], isError: record.status !== 'succeeded', structuredContent: record };
      } else throw new Error('Method not found');
      console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    } catch (error) { if (msg && Object.hasOwn(msg, 'id')) console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: error.message } })); else console.error(error.message); }
  }
} else {
  try {
    let input;
    if (action !== 'list') { let text = ''; for await (const chunk of process.stdin) { text += chunk; if (text.length > 1024 * 1024) throw new Error('Input too large'); } input = JSON.parse(text); }
    console.log(JSON.stringify(await request(action, input)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
