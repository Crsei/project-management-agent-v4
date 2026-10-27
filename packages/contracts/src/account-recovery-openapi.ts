const ref = (name:string) => ({ $ref:`#/components/schemas/${name}` });
const json = (schema:unknown) => ({ 'application/json':{schema} });
const failures = Object.fromEntries([400,401,403,409,429,503].map(status => [status,{description:'Sanitized authentication, validation, conflict, throttling or infrastructure error. Outcome may require original-identity reconciliation.',content:json(ref('ErrorResponse'))}]));
const operations = [
  ['security/recovery-email','beginRecoveryEmail','BeginRecoveryEmail','AccountSecurityAction',true,200],
  ['security/recovery-email/confirm','confirmRecoveryEmail','ConfirmRecoveryEmail','AccountSecurityAction',true,200],
  ['security/recovery-email/cancel','cancelRecoveryEmail','CancelRecoveryEmail','AccountSecurityAction',true,200],
  ['security/recovery-email/unbind','unbindRecoveryEmail','UnbindRecoveryEmail','AccountSecurityAction',true,200],
  ['password-recovery/requests','requestPasswordRecovery','RecoveryRequest','RecoveryRequestResult',false,202],
  ['password-recovery/requests/lookup','lookupRecoveryRequest','RecoveryRequestId','RecoveryRequestLookup',false,200],
  ['password-recovery/requests/recover','recoverRecoveryRequest','RecoveryRequestId','RecoveryRequestLookup',false,200],
  ['password-recovery/inspect','inspectPasswordRecovery','RecoveryToken','RecoveryInspection',false,200],
  ['password-recovery/complete','completePasswordRecovery','CompletePasswordRecovery','PasswordResetAction',false,200],
  ['password-recovery/actions/lookup','lookupPasswordResetAction','RecoveryActionInput','PasswordResetActionLookup',false,200],
  ['password-recovery/actions/recover','recoverPasswordResetAction','RecoveryActionInput','PasswordResetActionLookup',false,200],
] as const;
export const accountRecoveryPaths = Object.fromEntries(operations.map(([path,operationId,input,output,authenticated,status]) => [`/api/v1/auth/${path}`,{post:{operationId,summary:operationId,security:authenticated ? [{sessionCookie:[]},{bearerAuth:[]}] : [],description:'Account-global, no workspace. Strict POST JSON, no query, no-store and no-referrer. Never persist bearer/password inputs or replay writes after unknown outcomes. Request accepted is conditional and never proves account existence or mail delivery. Use original request/action lookup and explicit cancellation fence.',requestBody:{required:true,content:json(ref(input))},responses:{...failures,[status]:{description:'Original private action or uniform conditional request result.',content:json(ref(output))},...(output==='AccountSecurityAction' || output==='PasswordResetAction' ? {409:{description:'Durable rejected action, closed identity, or request error; reconcile original identity.',content:json({oneOf:[ref(output),ref('ErrorResponse')]})}} : {})}}}]));
