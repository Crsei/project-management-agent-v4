import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both bridge directions must propagate cancellation across their HTTP/socket hop.
export function forwardRequest(target, incoming, outgoing) {
  let upstreamResponse, cancelled = false;
  const cancel = () => {
    cancelled = true;
    incoming.unpipe(upstream);
    upstreamResponse?.destroy();
    upstream.destroy();
  };
  const fail = () => {
    if (cancelled || outgoing.destroyed || outgoing.writableFinished) return;
    cancel();
    if (outgoing.headersSent) outgoing.destroy();
    else { outgoing.writeHead(502); outgoing.end(); }
  };
  const upstream = request({ ...target, method: incoming.method, headers: incoming.headers }, response => {
    upstreamResponse = response;
    response.once('aborted', fail);
    response.once('error', fail);
    if (cancelled || outgoing.destroyed) { cancel(); return; }
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  upstream.once('error', fail);
  incoming.once('aborted', cancel);
  incoming.once('error', cancel);
  outgoing.once('error', cancel);
  outgoing.once('close', () => { if (!outgoing.writableFinished) cancel(); });
  if (incoming.aborted || outgoing.destroyed) cancel();
  else incoming.pipe(upstream);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const broker = createServer((incoming, outgoing) => forwardRequest({ socketPath: '/broker/host.sock', path: incoming.url ?? '/' }, incoming, outgoing));
  await new Promise((resolve, reject) => { broker.once('error', reject); broker.listen(3901, '127.0.0.1', resolve); });
  const control = createServer((incoming, outgoing) => forwardRequest({ host: '127.0.0.1', port: 3900, path: incoming.url }, incoming, outgoing));
  await new Promise((resolve, reject) => { control.once('error', reject); control.listen('/broker/agent.sock', resolve); });
  chmodSync('/broker/agent.sock', 0o600);
  const agent = spawn(process.execPath, ['--conditions=development', '/source/apps/server/agent/src/server.ts'], { cwd: '/source', env: process.env, stdio: 'inherit' });
  agent.once('exit', code => process.exit(code ?? 1));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => agent.kill(signal));
}
