import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createDashboardFixture } from './dashboard-fixture.ts';
import type { Entity } from '../packages/domain/src/core.ts';
import type { RoadmapRead } from '../packages/contracts/src/product-roadmap.ts';
import type { DesignBundle } from '../packages/contracts/src/product-design.ts';
import { feedbackScenario } from '../apps/web/src/features/pm/product-roadmap/model.ts';
import { createDesignZip } from '../apps/web/src/features/pm/product-roadmap/design-candidate.ts';

test('design: real upload → immutable artifact → authorized preview → frozen roadmap version; no business completion', {timeout:180000}, async()=>{
  const f=await createDashboardFixture();try {
    const project=await f.command('CreateProject',{name:'Design fixture',goal:'Preview only',ownerId:f.owner.id,completionCriteria:[]});
    const other=await f.command('CreateProject',{name:'Other design fixture',goal:'Isolation',ownerId:f.owner.id,completionCriteria:[]});
    const bytes=Buffer.from(createDesignZip({title:'反馈',notes:'清晰',files:[{name:'index.html',content:'<h1>客户反馈</h1>'}]}));
    const {upload}=await f.command<{upload:Entity}>('StageUpload',{contentBase64:bytes.toString('base64'),fileName:'design.zip',mediaType:'application/zip'},{extra:{projectId:project.id}});
    const {artifactVersion}=await f.command<{artifactVersion:Entity}>('RegisterArtifact',{title:'Feedback design',kind:'product-design',uploadId:upload.id},{extra:{projectId:project.id,expectedVersions:{[upload.id]:upload.version}}});
    const base=`/api/v1/workspaces/${f.workspaceId}/projects/${project.id}/product-roadmap`,url=`${base}/design/${artifactVersion.id}`;
    const preview=await f.request<DesignBundle>(url);assert.equal(preview.status,200,JSON.stringify(preview.body));assert.equal(preview.body.assets[0]?.name,'index.html');assert.equal(preview.body.sha256,artifactVersion.data.sha256);assert.equal(preview.headers.get('cache-control'),'private, no-store');
    assert.equal((await f.request(url,{cookie:''})).status,401);
    assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/projects/${other.id}/product-roadmap/design/${artifactVersion.id}`)).status,404);
    const limited=await f.member('Design limited');await f.command('SetWorkspaceMember',{userId:limited.user.id,capabilities:['domain.read','planning.edit'],projectIds:[other.id]});
    assert.equal((await f.request(url,{cookie:limited.cookie})).status,404);
    const read=async()=>(await f.request<RoadmapRead>(base)).body;
    const plan=feedbackScenario(randomUUID);plan.design={versionId:artifactVersion.id,sha256:preview.body.sha256,title:'反馈设计',notes:'清晰简洁；统一空态'};
    const save={action:'save',commandId:randomUUID(),revision:(await read()).revision,plan};
    const saved=await f.request(base,{method:'POST',body:save});assert.equal(saved.status,200,JSON.stringify(saved.body));
    const releaseId=randomUUID();assert.equal((await f.request(base,{method:'POST',body:{action:'publish',commandId:randomUUID(),revision:(await read()).revision,releaseId,confirm:true}})).status,200);
    const frozen=(await read()).store.releases[0]!.plan.design;assert.deepEqual(frozen,plan.design);
    const bad={...plan,design:{...plan.design,sha256:'0'.repeat(64)}};
    assert.equal((await f.request(base,{method:'POST',body:{...save,commandId:randomUUID(),revision:(await read()).revision,plan:bad}})).status,422);
    const changed={...plan,design:{...plan.design,notes:'新版说明'}};
    assert.equal((await f.request(base,{method:'POST',body:{...save,commandId:randomUUID(),revision:(await read()).revision,plan:changed}})).status,200);
    assert.deepEqual((await read()).store.releases[0]!.plan.design,frozen);
    assert.equal((await f.request(base,{method:'POST',body:{action:'materialize',releaseId,nodeId:plan.nodes[0]!.id,confirm:true}})).status,200);
    const latest=await read();assert.equal(latest.tasks[releaseId]![0]!.drifted,false);assert.notEqual(latest.tasks[releaseId]![0]!.status,'done');
  } finally{await f.close();}
});
