import assert from 'node:assert/strict';
import { createCipheriv,randomBytes,randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { AccountRecoveryClient } from '../packages/contracts/src/account-recovery-client.ts';
import { readAccountRecoveryMailConfig } from '../packages/infrastructure/src/account-recovery-mail.ts';
import { readInvitationMailConfig } from '../packages/infrastructure/src/invitation-mail.ts';
import { decryptMailToken,encryptMailToken } from '../packages/infrastructure/src/system-mail.ts';
import { parseAccountRecoveryMarker,serializeAccountRecoveryMarker } from '../apps/web/src/features/pm/service/account-recovery-marker.ts';
import { parseSecurityActionMarker,serializeSecurityActionMarker } from '../apps/web/src/features/pm/service/settings/account-security-recovery.ts';

it('separates feature configuration, rejects partial recovery and unsafe SMTP without echoing values',()=>{
  assert.equal(readAccountRecoveryMailConfig({SMTP_PASSWORD:'private-value'}),undefined);
  assert.throws(()=>readAccountRecoveryMailConfig({ACCOUNT_RECOVERY_TOKEN_KEY:'private-value'}),error=>error instanceof Error && !error.message.includes('private-value'));
  const env={SMTP_HOST:'127.0.0.1',SMTP_FROM:'security@example.test',SMTP_REQUIRE_TLS:'false',ACCOUNT_RECOVERY_WEB_ORIGIN:'http://127.0.0.1:4100',ACCOUNT_RECOVERY_TOKEN_KEY:randomBytes(32).toString('base64')};
  const recovery=readAccountRecoveryMailConfig(env);assert.ok(recovery);assert.equal(recovery.resetTtlSeconds,900);assert.equal(recovery.verifyTtlSeconds,1800);assert.equal(readInvitationMailConfig(env),undefined);
  assert.throws(()=>readAccountRecoveryMailConfig({...env,SMTP_HOST:'public.example.test'}));
  assert.throws(()=>readAccountRecoveryMailConfig({...env,PASSWORD_RESET_TTL_SECONDS:'7200'}));
  assert.throws(()=>readAccountRecoveryMailConfig({...env,ACCOUNT_RECOVERY_WEB_ORIGIN:'https://example.test/path'}));
});
it('decrypts historical invitation ciphertext unchanged and enforces recovery purpose/token/delivery AAD',()=>{
  const key=randomBytes(32),nonce=randomBytes(12),id=randomUUID(),token=randomBytes(32).toString('base64url');
  const oldCipher=createCipheriv('aes-256-gcm',key,nonce);oldCipher.setAAD(Buffer.from(id));
  const bytes=Buffer.concat([oldCipher.update(token,'utf8'),oldCipher.final()]);
  const oldQueue=Buffer.concat([nonce,oldCipher.getAuthTag(),bytes]).toString('base64');
  assert.equal(decryptMailToken(key,id,oldQueue),token);
  const encrypted=encryptMailToken(key,`reset_password:${id}:delivery`,token);
  assert.equal(decryptMailToken(key,`reset_password:${id}:delivery`,encrypted),token);
  assert.throws(()=>decryptMailToken(key,`verify_recovery_email:${id}:delivery`,encrypted));
  assert.throws(()=>decryptMailToken(key,`reset_password:${id}:different`,encrypted));
});
it('stores only explicit nonsecret IDs and rejects corrupted or widened records',()=>{
  const marker={kind:'password_reset' as const,actionId:randomUUID(),token:'private-token',password:'private-password',email:'private@example.test'};
  const encoded=serializeAccountRecoveryMarker(marker);assert.deepEqual(JSON.parse(encoded),{kind:marker.kind,actionId:marker.actionId});assert.ok(!encoded.includes('private'));
  assert.deepEqual(parseAccountRecoveryMarker(encoded),{kind:marker.kind,actionId:marker.actionId});
  for(const raw of ['{}','[]','malformed',JSON.stringify(marker)])assert.throws(()=>parseAccountRecoveryMarker(raw));
  for(const kind of ['recovery_email_begin','recovery_email_confirm','recovery_email_cancel','recovery_email_unbind'] as const){const action={kind,actionId:randomUUID()};assert.deepEqual(parseSecurityActionMarker(serializeSecurityActionMarker(action)),action);}
});
it('never accepts wrong IDs/kinds, malformed 2xx or HTTP status mismatches as a settled recovery action',async()=>{
  const actionId=randomUUID(),token='a'.repeat(43),stamp=new Date().toISOString();
  const reset={actionId,status:'committed',occurredAt:stamp,errorCode:null};
  for(const [status,body] of [[503,reset],[200,{...reset,actionId:randomUUID()}],[200,{unexpected:'private-response'}],[200,'not-json']] as const){
    const client=new AccountRecoveryClient(async()=>new Response(typeof body==='string'?body:JSON.stringify(body),{status}));
    await assert.rejects(client.complete(actionId,token,'private-new-password'),error=>error instanceof Error && !error.message.includes('private'));
  }
  const security={actionId,kind:'recovery_email_begin',status:'committed',credentialVersion:1,recoveryEmailVersion:1,challengeId:randomUUID(),revokedCount:0,errorCode:null,httpStatus:200,occurredAt:stamp};
  const input={actionId,expectedCredentialVersion:1,expectedRecoveryEmailVersion:1,email:'owner@example.test',currentPassword:'private-password'};
  for(const body of [{...security,kind:'recovery_email_confirm'},{...security,actionId:randomUUID()},{...security,httpStatus:409}]) {
    const client=new AccountRecoveryClient(async()=>new Response(JSON.stringify(body),{status:200}));await assert.rejects(client.begin(input));
  }
  const requestId=randomUUID(),client=new AccountRecoveryClient(async()=>new Response(JSON.stringify({requestId:randomUUID(),status:'accepted'}),{status:202}));
  await assert.rejects(client.request({requestId,email:'owner@example.test'}));
});
