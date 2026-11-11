import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync } from 'node:fs';

const proxy = (socketPath, targetPath, incoming, outgoing) => {
  const upstream = request({ socketPath, path: targetPath, method: incoming.method, headers: incoming.headers }, response => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
  incoming.pipe(upstream);
};
const broker = createServer((incoming, outgoing) => proxy('/broker/host.sock', incoming.url ?? '/', incoming, outgoing));
await new Promise((resolve, reject) => { broker.once('error', reject); broker.listen(3901, '127.0.0.1', resolve); });
const control = createServer((incoming, outgoing) => {
  const upstream = request({ host: '127.0.0.1', port: 3900, path: incoming.url, method: incoming.method, headers: incoming.headers }, response => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
  });
  upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); }); incoming.pipe(upstream);
});
await new Promise((resolve, reject) => { control.once('error', reject); control.listen('/broker/agent.sock', resolve); });
chmodSync('/broker/agent.sock', 0o600);
const agent = spawn(process.execPath, ['--conditions=development', '/source/apps/server/agent/src/server.ts'], { cwd: '/source', env: process.env, stdio: 'inherit' });
agent.once('exit', code => process.exit(code ?? 1));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => agent.kill(signal));
