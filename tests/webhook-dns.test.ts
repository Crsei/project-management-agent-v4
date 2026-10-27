import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { test } from 'node:test';
import { resolveWebhookAddresses } from '../packages/infrastructure/src/webhook-transport.ts';

function dnsName(value: string): Buffer { return Buffer.concat([...value.split('.').map(label => Buffer.concat([Buffer.from([label.length]),Buffer.from(label)])),Buffer.from([0])]); }
test('actual DNS answers are re-resolved; any private A/AAAA or private CNAME answer rejects the entire set', async t => {
  const socket = createSocket('udp4');
  let mode: 'public_a' | 'public_b' | 'private_a' | 'mixed_aaaa' | 'private_alias' = 'public_a';
  const names: string[] = [];
  socket.on('message', (message, remote) => {
    let end=12; const labels: string[]=[];
    while(message[end]) { const count=message[end]!; labels.push(message.subarray(end+1,end+1+count).toString()); end+=count+1; }
    end++; const name=labels.join('.'); names.push(name); const type=message.readUInt16BE(end); end+=4;
    const answers: Buffer[]=[];
    const record=(kind:number,data:Buffer)=>{const rr=Buffer.alloc(12);rr.writeUInt16BE(0xc00c,0);rr.writeUInt16BE(kind,2);rr.writeUInt16BE(1,4);rr.writeUInt32BE(1,6);rr.writeUInt16BE(data.length,10);answers.push(Buffer.concat([rr,data]));};
    if(type===1) record(1,Buffer.from(mode==='private_a'||mode==='private_alias'&&name==='alias.pm-webhook.com'?[10,0,0,1]:mode==='public_b'?[1,1,1,1]:[8,8,8,8]));
    if(type===28&&mode==='mixed_aaaa') record(28,Buffer.from('fd000000000000000000000000000001','hex'));
    if(type===5&&mode==='private_alias'&&name==='receiver.pm-webhook.com') record(5,dnsName('alias.pm-webhook.com'));
    const header=Buffer.alloc(12);message.copy(header,0,0,2);header.writeUInt16BE(0x8180,2);header.writeUInt16BE(1,4);header.writeUInt16BE(answers.length,6);
    socket.send(Buffer.concat([header,message.subarray(12,end),...answers]),remote.port,remote.address);
  });
  const bound=Promise.withResolvers<void>();socket.once('error',bound.reject);socket.bind(0,'127.0.0.1',bound.resolve);await bound.promise;
  t.after(()=>{socket.close()}); const address=socket.address();
  const resolve=()=>{const resolver=new Resolver({timeout:500,tries:1});resolver.setServers([`127.0.0.1:${address.port}`]);return resolveWebhookAddresses('receiver.pm-webhook.com',undefined,resolver)};
  assert.deepEqual(await resolve(),[{address:'8.8.8.8',family:4}]);
  mode='public_b';assert.deepEqual(await resolve(),[{address:'1.1.1.1',family:4}]);
  for(const denied of ['private_a','mixed_aaaa','private_alias'] as const){mode=denied;await assert.rejects(resolve(),/webhook_dns_denied/)}
  assert.ok(names.includes('alias.pm-webhook.com'));
});
