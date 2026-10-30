import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/pm/src/app.ts';
import { acquireMailFixtureDatabase } from './mail-fixture-database.ts';
import type { MailFixtureDatabase } from './mail-fixture-database.ts';
import { closeMailApp, MailFixtureScope, mailFixtureInitTimeout, mailSchemaInitTimeout } from './mail-fixture-lifecycle.ts';
import { LocalBlobStore } from '../packages/infrastructure/src/blobs.ts';
import { bindStorage } from '../packages/infrastructure/src/blob-storage-maintenance.ts';
import { createUser } from '../packages/infrastructure/src/auth.ts';
import type { AccountRecoveryMailConfig } from '../packages/infrastructure/src/account-recovery-mail.ts';
import { deliverAccountRecoveryMailBatch } from '../packages/application/src/account-recovery-delivery.ts';
import { createSmtpFixture,invitationDatabaseUrl } from './member-invitations-fixture.ts';
export const recoveryDatabaseUrl=invitationDatabaseUrl;
export const recoveryPassword='isolated-recovery-original-password';
export type RecoveryResponse<T=any>={status:number;body:T;headers:Headers};
export async function createRecoveryFixture(options:{disabled?:boolean;signal?:AbortSignal;database?:MailFixtureDatabase}={}) {
  const scope=new MailFixtureScope(options.signal,options.database ? mailFixtureInitTimeout : mailSchemaInitTimeout);
  return scope.initialize(async()=>{
  const {pool,databaseUrl}=await acquireMailFixtureDatabase(scope,options.database);
  const smtp=await scope.acquire(()=>createSmtpFixture({signal:scope.signal}),owned=>owned.close());
  const root=await scope.acquire(()=>mkdtemp(join(tmpdir(),'pm-account-recovery-')),owned=>rm(owned,{recursive:true,force:true}));
  // Deliberately no workspace membership and no artificial verified flags.
  const user=await scope.step(()=>createUser(pool,{email:`${randomUUID()}@example.test`,name:'Recovery owner',password:recoveryPassword}));
  const config:AccountRecoveryMailConfig={...smtp.config,tokenKey:randomBytes(32),resetTtlSeconds:900,verifyTtlSeconds:1800};
  const locator={provider:'local' as const,root:join(root,'blobs')},blobs=new LocalBlobStore(locator.root);
  await scope.step(()=>bindStorage({pool,provider:blobs,locator,mode:'new',stopped:true}));
  const coreRoot=join(root,'core');
  const app=scope.own(buildApp({databaseUrl,blobStore:blobs,blobStorageLocator:locator,coreWorkspaceRoot:coreRoot,signal:scope.signal,...(options.disabled ? {} : {accountRecoveryMail:config})}),closeMailApp);
  const origin=await scope.step(()=>app.listen({host:'127.0.0.1',port:0}));
  let cookie='';
  async function request<T=any>(path:string,body?:unknown,session=cookie):Promise<RecoveryResponse<T>> {
    const response=await fetch(`${origin}${path}`,{signal:scope.signal,method:body===undefined?'GET':'POST',headers:{cookie:session,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json() as T,headers:response.headers};
  }
  const logged=await scope.step(()=>request('/api/v1/auth/login',{email:user.email,password:recoveryPassword}));assert.equal(logged.status,200);
  cookie=logged.headers.get('set-cookie')!.split(';')[0]!;
  function token(purpose:'verify-recovery-email'|'recovery',email:string) {
    const message=[...smtp.messages].reverse().find(item=>item.to===email),text=message?.data.replace(/=\r\n/g,'').replace(/=3D/g,'=');
    const found=text && new RegExp(`/pm/account/${purpose}#token=([A-Za-z0-9_-]{43})`).exec(text)?.[1];
    assert.ok(found,'Token must come from a real SMTP DATA message');return found;
  }
  async function bind(email=`${randomUUID()}@example.test`) {
    const before=await request('/api/v1/auth/security');
    const started=await request('/api/v1/auth/security/recovery-email',{actionId:randomUUID(),expectedCredentialVersion:before.body.credentialVersion,expectedRecoveryEmailVersion:before.body.recoveryEmail.emailVersion,email,currentPassword:recoveryPassword});
    assert.equal(started.body.status,'committed',JSON.stringify(started.body));
    await deliverAccountRecoveryMailBatch(pool,config);
    const verified=await request('/api/v1/auth/security/recovery-email/confirm',{actionId:randomUUID(),token:token('verify-recovery-email',email),expectedRecoveryEmailVersion:before.body.recoveryEmail.emailVersion});
    assert.equal(verified.body.status,'committed',JSON.stringify(verified.body));return email;
  }
  return {pool,app,smtp,config,user,cookie,origin,databaseUrl,coreRoot,request,token,bind,close:scope.close};
  });
}
