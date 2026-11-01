import type { ChildProcess } from 'node:child_process';

/** Runs INSIDE the mount/network namespace. Host never resolves an app-controlled socket path. */
export const previewRelay = `import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createInterface } from 'node:readline';
const app = spawn('/usr/local/bin/node', ['--max-old-space-size=128', '/app/server.mjs'], {stdio:'ignore',env:process.env});
app.on('error',()=>process.exit(1)); app.on('exit',()=>process.exit(1));
createInterface({input:process.stdin}).on('line', line=>{
  let input; try { input=JSON.parse(line); } catch { process.exit(1); }
  const reply = (status,headers,body) => process.stdout.write(JSON.stringify({id:input.id,status,headers,body:body.toString('base64')})+'\\n');
  const req=request({socketPath:'/runtime/app.sock',agent:false,path:input.path,method:input.method,headers:input.headers,timeout:input.path==='/health'?300:3000},res=>{
    const chunks=[];let size=0;
    res.on('data',chunk=>{size+=chunk.length;if(size>4194304){res.destroy();return;}chunks.push(chunk)});
    res.on('end',()=>reply(res.statusCode,{ 'content-type': res.headers['content-type'] ?? 'text/plain' },Buffer.concat(chunks)));
    res.on('error',()=>reply(502,{},Buffer.from('App response unavailable')));
  });
  req.on('timeout',()=>req.destroy());req.on('error',()=>reply(502,{},Buffer.from('App unavailable')));
  req.end(Buffer.from(input.body,'base64'));
}).on('close',()=>{app.kill('SIGKILL');process.exit(0)});
`;

type Reply = { id: number; status: number; headers: { 'content-type'?: string }; body: string };
export class PreviewChannel {
  private next = 0;
  private buffer = '';
  private pending = new Map<number, { resolve: (v: Reply) => void; timer: NodeJS.Timeout }>();
  private child: ChildProcess;
  private closed = false;
  constructor(child: ChildProcess) {
    this.child = child;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 6 * 1024 * 1024) { child.kill('SIGKILL'); this.end(); return; }
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        try {
          const reply = JSON.parse(line) as Reply;
          if (!Number.isInteger(reply.id) || !Number.isInteger(reply.status) || reply.status < 100 || reply.status > 599 || typeof reply.body !== 'string' || !reply.headers || reply.headers['content-type'] !== undefined && typeof reply.headers['content-type'] !== 'string') throw new Error('Invalid relay reply');
          const item = this.pending.get(reply.id);
          if (item) { this.pending.delete(reply.id); clearTimeout(item.timer); item.resolve(reply); }
        } catch { child.kill('SIGKILL'); this.end(); }
      }
    });
    child.once('exit', () => this.end()); child.once('error', () => this.end());
    child.stdin!.on('error', () => this.end());
  }
  private end() { this.closed = true; for (const [id, item] of this.pending) { clearTimeout(item.timer); item.resolve({ id, status: 502, headers: {}, body: '' }); } this.pending.clear(); }
  call(method: string, path: string, headers: Record<string, string> = {}, body = Buffer.alloc(0)): Promise<Reply> {
    const id = ++this.next;
    if (this.closed || this.pending.size >= 32) return Promise.resolve({ id, status: 503, headers: {}, body: '' });
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ id, status: 504, headers: {}, body: '' }); }, 5000);
      this.pending.set(id, { resolve, timer });
      this.child.stdin!.write(`${JSON.stringify({ id, method, path, headers, body: body.toString('base64') })}\n`);
    });
  }
}
