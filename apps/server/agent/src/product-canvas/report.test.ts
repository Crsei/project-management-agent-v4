import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProductReport } from './report.ts';

test('automatic handoff reads exact committed product/legacy reports, never working tree or unchanged files', async () => {
  const directory=mkdtempSync(join(tmpdir(),'canvas-product-report-'));
  const git=(...args:string[])=>execFileSync('git',args,{cwd:directory,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
  try {
    git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    const path='docs/agent-handoffs/TASK-001.json';mkdirSync(join(directory,'docs/agent-handoffs'),{recursive:true});
    const commit=(raw:string)=>{writeFileSync(join(directory,path),raw);git('add',path);git('commit','-qm','report');return git('rev-parse','HEAD');};
    const initial={changes:['新增分类筛选'],capabilities:['提交反馈','分类筛选']};const a=commit(JSON.stringify(initial));
    const updated={changes:['改用标签筛选'],capabilities:['提交反馈','标签筛选']};const b=commit(JSON.stringify(updated));
    writeFileSync(join(directory,path),'uncommitted invalid JSON');
    assert.deepEqual(await readProductReport(directory,a,'TASK-001',[path]),initial);
    assert.deepEqual(await readProductReport(directory,b,'TASK-001',[path]),updated);
    assert.equal(await readProductReport(directory,b,'TASK-001',[]),undefined);
    assert.equal(await readProductReport(directory,b,'TASK-002',[path]),undefined);
    const legacy={interfaces:['old'],decisions:[],usage:'old',risks:[]};const c=commit(JSON.stringify(legacy));
    assert.deepEqual(await readProductReport(directory,c,'TASK-001',[path]),legacy);
    for(const raw of ['{bad',JSON.stringify({changes:['x']}),' '.repeat(16001)]) {
      const head=commit(raw);await assert.rejects(readProductReport(directory,head,'TASK-001',[path]));
    }
  } finally {rmSync(directory,{recursive:true,force:true});}
});
