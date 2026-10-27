import { z } from 'zod';
import { accountSecurityActionSchema } from './account-security-schemas.ts';
import { beginRecoveryEmailSchema, confirmRecoveryEmailSchema, cancelRecoveryEmailSchema, unbindRecoveryEmailSchema, recoveryRequestSchema, recoveryRequestResultSchema, recoveryRequestLookupSchema, recoveryInspectionSchema, passwordResetActionSchema, passwordResetActionLookupSchema } from './account-recovery-schemas.ts';
import type { AccountSecurityActionKind } from './account-security.ts';

/** Inject the existing client's #send transport. No second auth/cookie implementation. */
export class AccountRecoveryClient {
  private readonly send:(path:string,input:unknown)=>Promise<Response>;
  constructor(send:(path:string,input:unknown)=>Promise<Response>) { this.send=send; }
  async #post<T>(path:string,input:unknown,schema:z.ZodType<T>,correlate:(result:T,status:number)=>boolean):Promise<T> {
    const response = await this.send(path,input);
    let body:unknown;
    try { body=await response.json(); } catch { throw new Error('Account recovery response could not be confirmed'); }
    const parsed = schema.safeParse(body);
    if (parsed.success && correlate(parsed.data,response.status)) return parsed.data;
    // Do not put the raw response or input in errors, telemetry, or recovery markers.
    throw new Error(`Account recovery request could not be confirmed (HTTP ${response.status})`);
  }
  #security(path:string,input:{actionId:string},kind:AccountSecurityActionKind) {
    return this.#post(path,input,accountSecurityActionSchema,(action,status)=>action.actionId===input.actionId.toLowerCase() && action.kind===kind && action.httpStatus===status && (action.status==='rejected' ? status>=400 && status<500 : action.status==='committed' && status===200));
  }
  begin(input:z.infer<typeof beginRecoveryEmailSchema>) { return this.#security('/api/v1/auth/security/recovery-email',input,'recovery_email_begin'); }
  confirm(input:z.infer<typeof confirmRecoveryEmailSchema>) { return this.#security('/api/v1/auth/security/recovery-email/confirm',input,'recovery_email_confirm'); }
  cancel(input:z.infer<typeof cancelRecoveryEmailSchema>) { return this.#security('/api/v1/auth/security/recovery-email/cancel',input,'recovery_email_cancel'); }
  unbind(input:z.infer<typeof unbindRecoveryEmailSchema>) { return this.#security('/api/v1/auth/security/recovery-email/unbind',input,'recovery_email_unbind'); }
  request(input:z.infer<typeof recoveryRequestSchema>) { return this.#post('/api/v1/auth/password-recovery/requests',input,recoveryRequestResultSchema,(result,status)=>status===202 && result.requestId===input.requestId.toLowerCase()); }
  lookupRequest(requestId:string) { return this.#post('/api/v1/auth/password-recovery/requests/lookup',{requestId},recoveryRequestLookupSchema,(result,status)=>status===200 && (!result.request || result.request.requestId===requestId.toLowerCase())); }
  recoverRequest(requestId:string) { return this.#post('/api/v1/auth/password-recovery/requests/recover',{requestId},recoveryRequestLookupSchema,(result,status)=>status===200 && !!result.request && result.request.requestId===requestId.toLowerCase()); }
  inspect(token:string) { return this.#post('/api/v1/auth/password-recovery/inspect',{token},recoveryInspectionSchema,(_result,status)=>status===200); }
  complete(actionId:string,token:string,newPassword:string) { return this.#post('/api/v1/auth/password-recovery/complete',{actionId,token,newPassword},passwordResetActionSchema,(action,status)=>action.actionId===actionId.toLowerCase() && (action.status==='rejected' ? status===409 : action.status==='committed' && status===200)); }
  lookupAction(actionId:string,token:string) { return this.#post('/api/v1/auth/password-recovery/actions/lookup',{actionId,token},passwordResetActionLookupSchema,(result,status)=>status===200 && (!result.action || result.action.actionId===actionId.toLowerCase())); }
  recoverAction(actionId:string,token:string) { return this.#post('/api/v1/auth/password-recovery/actions/recover',{actionId,token},passwordResetActionLookupSchema,(result,status)=>status===200 && !!result.action && result.action.actionId===actionId.toLowerCase()); }
}
