export type AccountRecoveryMarker = {kind:'password_reset';actionId:string}|{kind:'recovery_request';requestId:string};
export function parseAccountRecoveryMarker(raw:string|null):AccountRecoveryMarker|null {
  if(raw===null) return null;
  const value:unknown=JSON.parse(raw);
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==2 || !('kind' in value)) throw new Error('Recovery marker is unavailable');
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if(value.kind==='password_reset' && 'actionId' in value && typeof value.actionId==='string' && uuid.test(value.actionId)) return {kind:value.kind,actionId:value.actionId};
  if(value.kind==='recovery_request' && 'requestId' in value && typeof value.requestId==='string' && uuid.test(value.requestId)) return {kind:value.kind,requestId:value.requestId};
  throw new Error('Recovery marker is unavailable');
}
export function serializeAccountRecoveryMarker(value:AccountRecoveryMarker):string {
  return value.kind==='password_reset' ? JSON.stringify({kind:value.kind,actionId:value.actionId}) : JSON.stringify({kind:value.kind,requestId:value.requestId});
}
