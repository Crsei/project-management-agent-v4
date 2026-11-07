import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { accessGuard } from '../access.ts';
import { productCanvasRoutes, startProductCanvases, stopProductCanvases } from './index.ts';
import { startTaskWorkflows, stopTaskWorkflows } from '../task-workflows/runner.ts';
import { closeStore, readRecord, writeRecord } from '../durable/store.ts';
import { emptyRoadmap } from '../../../../../packages/contracts/src/product-roadmap.ts';
import type { CanvasRun, CanvasStart } from '../../../../../packages/contracts/src/product-canvas.ts';
const input = (): CanvasStart => ({id:randomUUID(),workspaceId:randomUUID(),projectId:'PRJ-001',releaseId:randomUUID(),revision:'r1',repository:'owner/repo',baseBranch:'main',providerInstanceId:'codex',model:'selected',consent:{execute:true,worktreeWrite:true,commit:true,push:true,draftPr:true,taskStatus:true,createTasks:true}});
test('canvas HTTP denies foreign origin, scope extras, missing consent and missing PM authentication; runner readiness is explicit',async()=>{
  const env={data:process.env.AGENT_WORKSPACE_DATA_DIR,token:process.env.AGENT_WORKSPACE_ACCESS_TOKEN}, original=globalThis.fetch, directory=mkdtempSync(join(tmpdir(),'pm-canvas-route-'));
  process.env.AGENT_WORKSPACE_DATA_DIR=directory;process.env.AGENT_WORKSPACE_ACCESS_TOKEN='';
  let calls=0;globalThis.fetch=async()=>{calls++;return new Response('',{status:401});};
  try {
    const app=new Hono().use('/api/*',accessGuard).route('/api',productCanvasRoutes),url='http://127.0.0.1:4325/api/product-canvases',headers={host:'127.0.0.1:4325','content-type':'application/json'},value=input();
    assert.equal((await app.request(`${url}/runs`,{method:'POST',headers:{...headers,origin:'https://evil.invalid'},body:JSON.stringify(value)})).status,403);
    assert.equal((await app.request(`${url}/runs`,{method:'POST',headers,body:JSON.stringify(value)})).status,503);
    assert.equal((await app.request(`${url}?workspaceId=${value.workspaceId}&projectId=PRJ-001&cwd=/root`,{headers})).status,400);assert.equal(calls,0);
    assert.equal((await app.request(`${url}?workspaceId=${value.workspaceId}&projectId=PRJ-001`,{headers})).status,401);assert.equal(calls,1);
    startTaskWorkflows();startProductCanvases();
    assert.equal((await app.request(`${url}/runs`,{method:'POST',headers,body:JSON.stringify({...value,cwd:'/root'})})).status,400);
    assert.equal((await app.request(`${url}/runs`,{method:'POST',headers,body:JSON.stringify({...value,consent:{...value.consent,push:false}})})).status,400);assert.equal(calls,1);
    assert.equal((await app.request(`${url}/runs`,{method:'POST',headers,body:JSON.stringify(value)})).status,401);assert.equal(calls,2);
    assert.equal((await app.request(`${url}/runs/${value.id}/control`,{method:'POST',headers,body:JSON.stringify({action:'resume',version:1})})).status,400);
    assert.equal(readRecord('product-canvas-runs-v1',value.id),null);
  } finally { await stopProductCanvases();await stopTaskWorkflows();closeStore();globalThis.fetch=original;for(const[k,v]of Object.entries({AGENT_WORKSPACE_DATA_DIR:env.data,AGENT_WORKSPACE_ACCESS_TOKEN:env.token})){if(v===undefined)delete process.env[k];else process.env[k]=v;}rmSync(directory,{recursive:true,force:true}); }
});
test('restart converts durable running canvases to paused without dispatching effects or resuming credentials',async()=>{
  const old=process.env.AGENT_WORKSPACE_DATA_DIR,directory=mkdtempSync(join(tmpdir(),'pm-canvas-restart-'));process.env.AGENT_WORKSPACE_DATA_DIR=directory;
  try {
    const value=input(), now=new Date().toISOString();const r:CanvasRun={id:value.id,input:value,version:1,plan:emptyRoadmap(),nodes:[],status:'running',message:'',createdAt:now,updatedAt:now};writeRecord('product-canvas-runs-v1',r.id,r);
    startProductCanvases();const saved=readRecord<CanvasRun>('product-canvas-runs-v1',r.id)!;assert.equal(saved.status,'paused');assert.equal(saved.version,2);assert.match(saved.message,/重启/);assert.deepEqual(saved.input,value);await stopProductCanvases();
    startProductCanvases();assert.equal(readRecord<CanvasRun>('product-canvas-runs-v1',r.id)!.version,2);
  } finally {await stopProductCanvases();closeStore();if(old===undefined)delete process.env.AGENT_WORKSPACE_DATA_DIR;else process.env.AGENT_WORKSPACE_DATA_DIR=old;rmSync(directory,{recursive:true,force:true});}
});
