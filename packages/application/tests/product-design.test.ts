import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { inspectDesignBytes, resolveProductDesign } from '../src/product-design.ts';
import { createDesignZip, readDesignCandidate, designCandidateSchema } from '../../../apps/web/src/features/pm/product-roadmap/design-candidate.ts';
import { emptyRoadmap } from '../../contracts/src/product-roadmap.ts';
import { sharedContextVersion } from '../src/task-context.ts';
const candidate={title:'安静、清晰',notes:'页面及空态',files:[{name:'index.html',content:'<h1>反馈</h1><p>暂无反馈</p>'},{name:'style.css',content:'body { color: #222 }'}]};
const zip=()=>Buffer.from(createDesignZip(candidate));
test('generated design ZIP round trips through the same bounded upload parser, preserving Chinese content',()=>{
  const result=inspectDesignBytes(zip(),'design.zip');assert.equal(result.assets.length,2);assert.deepEqual(result.unsupported,[]);assert.equal(Buffer.from(result.assets[0]!.base64,'base64').toString(),candidate.files[0]!.content);assert.match(result.sha256,/^[a-f0-9]{64}$/);
});
test('real deflate entries and direct images are supported without extracting or executing anything',()=>{
  const stored=Buffer.from(createDesignZip({...candidate,files:[candidate.files[0]!]}));const data=Buffer.from(candidate.files[0]!.content),compressed=deflateRawSync(data),nameLength=stored.readUInt16LE(26),end=stored.length-22,centralAt=stored.readUInt32LE(end+16),directory=Buffer.from(stored.subarray(centralAt,end)),local=Buffer.from(stored.subarray(0,30+nameLength)),footer=Buffer.from(stored.subarray(end));
  local.writeUInt16LE(8,8);local.writeUInt32LE(compressed.length,18);directory.writeUInt16LE(8,10);directory.writeUInt32LE(compressed.length,20);footer.writeUInt32LE(local.length+compressed.length,16);
  assert.equal(inspectDesignBytes(Buffer.concat([local,compressed,directory,footer]),'design.zip').assets[0]!.name,'index.html');
  assert.equal(inspectDesignBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),'flow.svg').assets[0]!.mediaType,'image/svg+xml');
});
test('reject traversal, duplicate names, symlinks, encrypted entries, corruption, oversized expansion and bad archives',()=>{
  for(const edit of [
    (b:Buffer,c:number)=>{b.write('../bad.htm',30);b.write('../bad.htm',c+46);},
    (b:Buffer,c:number)=>b.writeUInt32LE(0xa000*65536,c+38),
    (b:Buffer,c:number)=>b.writeUInt16LE(1,c+8),
    (b:Buffer,c:number)=>b.writeUInt32LE(0,c+16),
    (b:Buffer,c:number)=>b.writeUInt32LE(3*1024*1024,c+24),
    (b:Buffer,c:number)=>b.writeUInt32LE(0xffffffff,c+42),
  ]){const bytes=zip(),central=bytes.readUInt32LE(bytes.length-6);edit(bytes,central);assert.throws(()=>inspectDesignBytes(bytes,'x.zip'));}
  assert.throws(()=>inspectDesignBytes(Buffer.alloc(30),'x.zip'));
  assert.throws(()=>inspectDesignBytes(Buffer.alloc(8*1024*1024+1),'x.png'));
  assert.throws(()=>inspectDesignBytes(Buffer.from('script'),'x.js'));
  assert.equal(designCandidateSchema.safeParse({...candidate,files:[candidate.files[0],candidate.files[0]]}).success,false);
});
test('only a matching completed assistant message becomes a generated design',()=>{
  const reply={id:'reply',content:{role:'assistant',parts:[{type:'text',text:'```json\n'+JSON.stringify(candidate)+'\n```'}]}};
  const history={latestGeneration:{id:'g',messageId:'reply',status:'completed'},messages:[reply]};
  assert.deepEqual(readDesignCandidate(history),candidate);assert.equal(readDesignCandidate({...history,activeGenerationId:'active'}),null);
  assert.throws(()=>readDesignCandidate({...history,messages:[{...reply,content:{...reply.content,role:'user'}}]}));
  assert.throws(()=>readDesignCandidate({...history,latestGeneration:{...history.latestGeneration,status:'failed'}}));
});
test('design resolver enforces project/version ownership before reading bytes and matches frozen digest',async()=>{
  const id=randomUUID();let downloads=0;const ports={version:async()=>({kind:'artifact_version',projectId:'PRJ-1'}),content:async()=>{downloads++;return {bytes:zip(),fileName:'design.zip'};}};
  await assert.rejects(resolveProductDesign({versionId:id,projectId:'PRJ-2'},ports),/不属于/);assert.equal(downloads,0);
  const bundle=await resolveProductDesign({versionId:id,projectId:'PRJ-1'},ports);assert.equal(bundle.versionId,id);
  await assert.rejects(resolveProductDesign({versionId:id,projectId:'PRJ-1',expected:{versionId:id,sha256:'0'.repeat(64),title:'x',notes:''}},ports),/校验/);
});
test('legacy context hashes stay stable and a design version, digest or notes change invalidates context',()=>{
  const plan=emptyRoadmap(),legacy=sharedContextVersion(plan.brief);assert.equal(sharedContextVersion(plan.brief,undefined),legacy);
  const design={versionId:randomUUID(),sha256:'a'.repeat(64),title:'design',notes:'安静'};const hash=sharedContextVersion(plan.brief,design);assert.notEqual(hash,legacy);
  for(const patch of [{versionId:randomUUID()},{sha256:'b'.repeat(64)},{notes:'明亮'}])assert.notEqual(sharedContextVersion(plan.brief,{...design,...patch}),hash);
});
