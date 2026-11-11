import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Duplex } from 'node:stream';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

type GatewayOptions = { pmUrl?: string; agentUrl?: string; webDevUrl?: string; webDist?: string };
type Destination = { target: URL; path: string };

function upstream(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Invalid gateway upstream: ${value}`);
  }
  return url;
}

export function createGateway(options: GatewayOptions = {}) {
  const pm = upstream(options.pmUrl ?? process.env.PM_URL ?? 'http://127.0.0.1:4194');
  const agent = upstream(options.agentUrl ?? process.env.AGENT_URL ?? 'http://127.0.0.1:4325');
  const devValue = options.webDevUrl ?? process.env.WEB_DEV_URL;
  const dev = devValue ? upstream(devValue) : undefined;
  const webDist = path.resolve(options.webDist ?? process.env.WEB_DIST ?? path.join(repositoryRoot, 'apps/web/dist'));

  function route(url: string): Destination | null | undefined {
    if (!url.startsWith('/') || url.startsWith('//')) throw new Error('Invalid request target');
    const rawPath = url.split('?', 1)[0]!;
    if (/%2f|%5c/i.test(rawPath)) throw new Error('Encoded path separator');
    const pathname = decodeURIComponent(new URL(url, 'http://gateway.invalid').pathname);
    // Service-authenticated reconciliation is private even when its path is percent-encoded.
    if (pathname === '/api/v1/internal' || pathname.startsWith('/api/v1/internal/')) return null;
    // Only the external MCP protocol and OAuth discovery/handshake are public.
    // Grant introspection stays on the private service transport, never this gateway.
    if (pathname === '/mcp' ||
        pathname === '/.well-known/oauth-protected-resource' ||
        pathname === '/.well-known/oauth-protected-resource/mcp' ||
        pathname === '/.well-known/oauth-authorization-server' ||
        /^\/oauth\/mcp\/(?:register|authorize|approval|decision|token)$/.test(pathname)) {
      return { target: agent, path: url };
    }
    if (pathname === '/agent/api' || pathname.startsWith('/agent/api/')) {
      if (!rawPath.startsWith('/agent/')) throw new Error('Invalid agent path');
      return { target: agent, path: url.slice('/agent'.length) };
    }
    if (pathname === '/api' || pathname.startsWith('/api/') || pathname === '/health' || pathname.startsWith('/health/') || pathname === '/openapi.json') {
      return { target: pm, path: url };
    }
    return dev ? { target: dev, path: url } : undefined;
  }

  function proxy(req: IncomingMessage, res: ServerResponse, target: URL, requestPath: string) {
    const transport = target.protocol === 'https:' ? https : http;
    const outgoing = transport.request(target, { method: req.method, path: requestPath, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    outgoing.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      if (!res.destroyed) res.end('{"error":"upstream_unavailable"}');
    });
    req.on('aborted', () => outgoing.destroy());
    res.on('close', () => { if (!res.writableFinished) outgoing.destroy(); });
    req.pipe(outgoing);
  }

  async function serveFile(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://gateway.invalid').pathname); }
    catch { res.writeHead(400).end(); return; }
    if (pathname.includes('\0') || pathname.includes('\\')) { res.writeHead(400).end(); return; }
    const filename = path.resolve(webDist, `.${pathname}`);
    if (filename !== webDist && !filename.startsWith(webDist + path.sep)) { res.writeHead(403).end(); return; }
    let file = filename;
    let info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) {
      // Missing assets are errors, not successful HTML responses.
      const applicationRoute = pathname === '/pm' || pathname.startsWith('/pm/') || pathname === '/agent' || pathname.startsWith('/agent/');
      if ((!applicationRoute && path.extname(pathname)) || pathname.startsWith('/assets/') || pathname.startsWith('/fixtures/')) {
        res.writeHead(404).end(); return;
      }
      file = path.join(webDist, 'index.html');
      info = await stat(file).catch(() => undefined);
    }
    if (!info?.isFile()) { res.writeHead(404).end(); return; }
    const headers: Record<string, string | number> = {
      'content-type': contentTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'x-content-type-options': 'nosniff',
      'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    if (pathname === '/connect-agent' || pathname === '/pm/account' || pathname.startsWith('/pm/account/')) {
      headers['cache-control'] = 'no-store';
      headers['referrer-policy'] = 'no-referrer';
      headers['content-security-policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  const server = http.createServer((req, res) => {
    try {
      const destination = route(req.url ?? '/');
      if (destination === null) res.writeHead(404, { 'cache-control': 'no-store' }).end();
      else if (destination) proxy(req, res, destination.target, destination.path);
      else void serveFile(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
    } catch { res.writeHead(400).end(); }
  });
  const connections = new Set<Duplex>();
  server.on('connection', socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  server.on('upgrade', (req, socket: Duplex, head) => {
    let destination: Destination | null | undefined;
    try { destination = route(req.url ?? '/'); } catch { socket.destroy(); return; }
    if (!destination) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    const transport = destination.target.protocol === 'https:' ? https : http;
    const outgoing = transport.request(destination.target, { method: req.method, path: destination.path, headers: req.headers });
    outgoing.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      socket.write(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n`);
      for (let i = 0; i < response.rawHeaders.length; i += 2) socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`);
      socket.write('\r\n');
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.on('error', () => socket.destroy());
      socket.on('error', () => upstreamSocket.destroy());
      socket.once('close', () => upstreamSocket.destroy());
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    outgoing.on('response', (response) => {
      socket.write(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n`);
      for (let i = 0; i < response.rawHeaders.length; i += 2) socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`);
      socket.write('\r\n');
      response.pipe(socket);
    });
    outgoing.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
    socket.on('close', () => outgoing.destroy());
    outgoing.end();
  });
  let stopping: Promise<void> | undefined;
  return Object.assign(server, {
    shutdown(graceMs = 5000): Promise<void> {
      stopping ??= new Promise<void>(resolve => {
        const timer = setTimeout(() => { for (const socket of connections) socket.destroy(); }, graceMs);
        timer.unref();
        server.close(() => { clearTimeout(timer); resolve(); });
      });
      return stopping;
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const host = process.env.PUBLIC_HOST?.trim() || '127.0.0.1';
  const rawPort = process.env.PUBLIC_PORT ?? '3224';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PUBLIC_PORT must be an integer between 1 and 65535');
  const server = createGateway();
  server.listen(port, host, () => console.log(`public gateway listening on http://${host.includes(':') ? `[${host}]` : host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.shutdown(); });
}
