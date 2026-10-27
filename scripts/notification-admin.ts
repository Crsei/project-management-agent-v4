import { z } from 'zod';
import { DomainError } from '../packages/domain/src/core.ts';
import { createPool } from '../packages/infrastructure/src/database.ts';
import { readNotificationOperations,retryNotificationFact } from '../packages/application/src/notification-routing.ts';
const usage='Usage: notification-admin.ts status --workspace UUID | retry --workspace UUID --fact UUID';
async function main():Promise<void> {
 const args=process.argv.slice(2);
 if(args.length===1&&['-h','--help'].includes(args[0]!)){console.log(usage);return;}
 if(!['status','retry'].includes(args[0]??'')||args[1]!=='--workspace'||(args[0]==='status'?args.length!==3:args.length!==5||args[3]!=='--fact'))throw new DomainError('invalid_arguments',usage);
 const workspace=z.uuid().toLowerCase().parse(args[2]),fact=args[0]==='retry'?z.uuid().toLowerCase().parse(args[4]):null;
 if(!process.env.DATABASE_URL)throw new DomainError('database_not_configured');
 const pool=createPool(process.env.DATABASE_URL);
 try {
  if(fact){const uid=process.getuid?.();if(uid===undefined)throw new DomainError('operator_identity_unavailable');await retryNotificationFact(pool,workspace,fact,uid);console.log(JSON.stringify({workspaceId:workspace,factId:fact,retried:true}));}
  else console.log(JSON.stringify(await readNotificationOperations(pool,workspace)));
 }finally{await pool.end();}
}
try{await main();}catch(error){console.error(JSON.stringify({error:{code:error instanceof DomainError?error.code:error instanceof z.ZodError?'invalid_arguments':'notification_maintenance_failed'}}));process.exitCode=1;}
