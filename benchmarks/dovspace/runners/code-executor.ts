import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { benchmarkConfig, type BenchmarkConfig } from '../benchmark.config.ts';
import type { CodeExecutionRequest, CodeExecutionResult, CodeExecutor } from '../graders/types.ts';
import { docker, inspectOwned, OWNER_LABEL, ownerIdentity, removeOwnedName } from '../isolation/docker.ts';

/** Hidden expected values remain in the grader; only black-box invocation inputs enter this sandbox. */
export async function executeCode(input: CodeExecutionRequest, config: BenchmarkConfig = benchmarkConfig): Promise<CodeExecutionResult> {
  let name = '', owner = '';
  const evidence: string[] = [];
  let result: CodeExecutionResult = { outputs: [], exitCode: 1, isolationVerified: false, evidence };
  try {
    if (!path.isAbsolute(input.repoDir) || await realpath(input.repoDir) !== input.repoDir || path.isAbsolute(input.modulePath) || input.modulePath.split(/[\\/]/).includes('..') || input.mode !== 'node-test' && !/^[A-Za-z_$][\w$]*$/.test(input.exportName)) throw new Error('Hidden code execution requires an explicit unredirected repository/module/export.');
    const relative = path.relative(config.runtimeRoot, input.repoDir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Submitted code must remain under an owned benchmark runtime root.');
    const uid = process.getuid?.(), gid = process.getgid?.();
    if (uid === undefined || gid === undefined || uid === 0) throw new Error('Code grading requires an unprivileged Linux operator.');
    const module = await lstat(path.join(input.repoDir, input.modulePath));
    if (!module.isFile() || module.isSymbolicLink() || module.nlink !== 1 || module.size > 1024 * 1024) throw new Error('Submitted module is not a bounded regular single-link file.');
    let entries = 0, treeBytes = 0;
    async function inspectTree(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++entries > 5000) throw new Error('Candidate repository exceeds the bounded entry count.');
        const absolute = path.join(directory, entry.name), info = await lstat(absolute);
        if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw new Error('Candidate repository contains a link or special file.');
        if (info.isDirectory()) await inspectTree(absolute);
        else if ((treeBytes += info.size) > 64 * 1024 * 1024) throw new Error('Candidate repository exceeds the bounded source size.');
      }
    }
    await inspectTree(input.repoDir);
    if (input.invocations.length > 1000 || JSON.stringify(input.invocations).length > 1024 * 1024) throw new Error('Hidden invocation input limit exceeded.');
    owner = await ownerIdentity();
    name = `dovspace-bench-code-${randomUUID().replaceAll('-', '')}`;
    const marker = `DOVSPACE_RESULT_${randomUUID().replaceAll('-', '')}:`;
    const isolationMarker = `DOVSPACE_ISOLATION_${randomUUID().replaceAll('-', '')}`;
    const payload = JSON.stringify({ modulePath: input.modulePath, exportName: input.exportName, invocations: input.invocations });
    const probe = `import fs from 'node:fs';const write=process.stdout.write.bind(process.stdout);if(process.versions.node!=='24.21.0')throw Error('Code runtime must be Node24.21.0.');for(const p of ['/source/apps/server/agent/src/server.ts','/source/benchmarks/dovspace/graders/index.ts','/agent-data/agent.sqlite','/broker/host.sock','/var/run/docker.sock','/root/.env','/root/.codex/auth.json']){try{fs.readFileSync(p);throw Error('Sensitive code sandbox content is readable.');}catch(error){if(!['ENOENT','EACCES'].includes(error.code))throw error;}}let writable=false;try{fs.writeFileSync('/subject/.isolation-write-probe','denied');writable=true;}catch{}if(writable)throw Error('Candidate source mount is writable.');write(${JSON.stringify(isolationMarker)}+'\\n');`;
    // Candidate code receives a separate realm, never the harness process/stdout/control channel.
    const program = input.mode === 'node-test'
      ? `${probe}import{spawnSync}from'node:child_process';const child=spawnSync(process.execPath,['--test','--test-reporter=tap',${JSON.stringify('/subject/' + input.modulePath)}],{encoding:'utf8',timeout:25000,maxBuffer:8388608});const tap=child.stdout??'';write(tap);const summary=[...tap.matchAll(/^# tests (\\d+)$/gm)].at(-1);const passed=[...tap.matchAll(/^# pass (\\d+)$/gm)].at(-1);const failed=[...tap.matchAll(/^# fail (\\d+)$/gm)].at(-1);const premature=tap.split('\\n').some(line=>line.startsWith('# Subtest: /subject/')||line.startsWith('# Subtest: test/'));if(child.status!==0||premature||!summary||!passed||!failed||Number(summary[1])<${input.modulePath === 'test/retry.test.ts' ? 2 : 1}||Number(passed[1])!==Number(summary[1])||Number(failed[1])!==0)process.exitCode=1;`
      : `${probe}
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
process.on('unhandledRejection',()=>process.exit(1));
process.on('uncaughtException',()=>process.exit(1));
const input=JSON.parse(${JSON.stringify(payload)});
const realm=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false},microtaskMode:'afterEvaluate'});
// Drain only the candidate microtask queue; never expose rejected candidate objects to host diagnostics.
async function evaluate(module){
  let settled=false,failed=false;
  const deadline=Date.now()+1000;
  module.evaluate({timeout:1000}).then(()=>{settled=true;},()=>{failed=true;settled=true;});
  await Promise.resolve();
  while(!settled&&Date.now()<deadline){
    await delay(1);
    vm.runInContext('',realm,{timeout:1000});
  }
  if(!settled||failed)throw Error('Candidate module evaluation failed or timed out.');
}
vm.runInContext('const __codec=(()=>{const stringify=JSON.stringify,parse=JSON.parse,keys=Reflect.ownKeys,descriptor=Object.getOwnPropertyDescriptor,prototype=Object.getPrototypeOf,create=Object.create,setPrototype=Object.setPrototypeOf,isArray=Array.isArray,plain=Object.prototype,finite=Number.isFinite;let entries=0;function copy(value,depth){if(depth>30||++entries>10000)throw Error("Candidate result exceeds data limits.");if(value===null||typeof value==="string"||typeof value==="boolean")return value;if(typeof value==="number"&&finite(value))return value;if(typeof value!=="object"||(!isArray(value)&&prototype(value)!==plain&&prototype(value)!==null))throw Error("Only synchronous JSON data results are allowed.");const output=isArray(value)?setPrototype([],null):create(null);for(const key of keys(value)){if(typeof key!=="string")throw Error("Symbol result keys are not allowed.");const field=descriptor(value,key);if(!field||!("value" in field))throw Error("Result accessors are not allowed.");if(field.enumerable)output[key]=copy(field.value,depth+1);}return output;}return Object.freeze({decode:parse,encode(value){entries=0;return stringify(copy(value,0));}})})();',realm,{timeout:1000});
const source=stripTypeScriptTypes(fs.readFileSync('/subject/'+input.modulePath,'utf8'),{mode:'strip'});
// Rejection reasons crossing into candidate code MUST be primitives, never outer-realm Errors/objects.
const candidate=new vm.SourceTextModule(source,{context:realm,identifier:'candidate',importModuleDynamically(){return Promise.reject(null);}});
await candidate.link(()=>Promise.reject(null));
try{await evaluate(candidate);}catch{throw Error('Candidate module initialization failed.');}
if(typeof candidate.namespace[input.exportName]!=='function')throw Error('Missing synchronous function export.');
const outputs=[],invocationErrors=[];
for(const invocation of input.invocations){
  const args=JSON.stringify(JSON.stringify(invocation.args));
  const invocationModule=new vm.SourceTextModule('import{'+input.exportName+' as fn}from"candidate";export const output=__codec.encode(fn(...__codec.decode('+args+')))',{context:realm,identifier:'invocation'});
  try{
    await invocationModule.link(specifier=>specifier==='candidate'?candidate:Promise.reject(null));
    await evaluate(invocationModule);
    const serialized=invocationModule.namespace.output;
    if(typeof serialized!=='string')throw Error('Candidate result is not JSON data.');
    outputs.push(JSON.parse(serialized));invocationErrors.push(null);
  }catch{
    outputs.push(null);invocationErrors.push('Candidate invocation failed');
  }
}
write(${JSON.stringify(marker)}+JSON.stringify({outputs,invocationErrors})+'\\n');`;
    const nodeArgs = ['--experimental-vm-modules', '--input-type=module', '--eval', program];
    const id = await docker(['create', '--pull', 'never', '--name', name, '--label', `${OWNER_LABEL}=${owner}`, '--network', 'none', '--read-only', '--user', `${uid}:${gid}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '256m', '--cpus', '1', '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m', '--mount', `type=bind,src=${input.repoDir},dst=/subject,readonly`, '--workdir', '/subject', '--env', 'HOME=/tmp', '--env', 'LANG=C.UTF-8', '--entrypoint', '/usr/local/bin/node', config.codeImage, ...nodeArgs]);
    const inspection = await inspectOwned(id, owner);
    if (inspection.HostConfig.NetworkMode !== 'none' || !inspection.HostConfig.ReadonlyRootfs || inspection.HostConfig.Privileged || inspection.HostConfig.PidMode === 'host' || inspection.Config.User !== `${uid}:${gid}` || !inspection.HostConfig.CapDrop.includes('ALL') || !inspection.HostConfig.SecurityOpt.some(value => value.startsWith('no-new-privileges')) || inspection.Mounts.length !== 1 || inspection.Mounts[0]?.Destination !== '/subject' || inspection.Mounts.some(mount => mount.RW)) throw new Error('Code sandbox isolation inspection failed.');
    evidence.push(`owned-container:${id}`, `image:${inspection.Image}`, 'network:none', 'unprivileged-readonly', 'private-container-pid-mount-network', 'only-submitted-source-mounted', `invocations:${input.invocations.length}`);
    await docker(['start', id]);
    const exitCode = Number(await docker(['wait', id], {}, 30_000));
    const output = await docker(['logs', id]);
    result.isolationVerified = output.split('\n').includes(isolationMarker);
    result.exitCode = Number.isInteger(exitCode) && exitCode >= 0 ? exitCode : 1;
    if (!result.isolationVerified) throw new Error('The nested code isolation denial probe did not execute.');
    evidence.push(`exit:${result.exitCode}`, `isolation-probe:${isolationMarker}`);
    if (result.exitCode !== 0) throw new Error(`Candidate code execution failed with exit ${result.exitCode}.`);
    if (input.mode === 'node-test') {
      evidence.push(`node --test ${input.modulePath}`, output.slice(-16_384));
      result = { outputs: [], exitCode: 0, isolationVerified: true, evidence };
    } else {
      const lines = output.split('\n').filter(line => line.startsWith(marker));
      if (lines.length !== 1) throw new Error('Candidate code did not produce exactly one trusted invocation result.');
      const payload: unknown = JSON.parse(lines[0]!.slice(marker.length));
      if (!payload || typeof payload !== 'object' || !('outputs' in payload) || !('invocationErrors' in payload)) throw new Error('Candidate invocation result is malformed.');
      const { outputs, invocationErrors } = payload;
      if (!Array.isArray(outputs) || outputs.length !== input.invocations.length || !Array.isArray(invocationErrors) || invocationErrors.length !== outputs.length || invocationErrors.some(value => value !== null && typeof value !== 'string')) throw new Error('Candidate invocation result is malformed.');
      result = { outputs, invocationErrors, exitCode: 0, isolationVerified: true, evidence };
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (name && owner) {
      try { await removeOwnedName(name, owner); }
      catch { result = { ...result, exitCode: 1, isolationVerified: false, error: 'Owned code sandbox cleanup failed; no successful grade is claimed.' }; }
    }
  }
  return result;
}

export function createCodeExecutor(config: BenchmarkConfig): CodeExecutor {
  return input => executeCode(input, config);
}
