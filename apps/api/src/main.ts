import { buildApp } from './app.ts';
import { readConfig } from './config.ts';
import { runtimeConfig } from '../../../packages/infrastructure/src/runtime-config.ts';
import { readInvitationMailConfig } from '../../../packages/infrastructure/src/invitation-mail.ts';
import { readAccountRecoveryMailConfig } from '../../../packages/infrastructure/src/account-recovery-mail.ts';
import { readWebhookConfig } from '../../../packages/infrastructure/src/webhook-config.ts';
import { readAgentChatConfig } from '../../../packages/infrastructure/src/agent-chat-config.ts';
import { readBlobStoreConfig, blobStorageLocator } from '../../../packages/infrastructure/src/blob-storage-config.ts';
import { createBlobStore } from '../../../packages/infrastructure/src/blob-storage-provider.ts';

const config = readConfig();
const runtime = runtimeConfig();
const invitationMail = readInvitationMailConfig();
const accountRecoveryMail = readAccountRecoveryMailConfig();
const agentChat = readAgentChatConfig();
const storage = runtime.databaseUrl ? readBlobStoreConfig() : { provider: 'disabled' as const };
const app = buildApp({ logger: true, ...(runtime.databaseUrl ? { databaseUrl: runtime.databaseUrl } : {}), blobStore: createBlobStore(storage), blobStorageLocator: blobStorageLocator(storage), coreWorkspaceRoot: runtime.coreWorkspaceRoot, chatSpaceRoot: runtime.chatSpaceRoot, localProjects: runtime.localProjects, publicOrigin: runtime.publicOrigin, cookieSecure: runtime.cookieSecure, ...(invitationMail ? { invitationMail } : {}), ...(accountRecoveryMail ? { accountRecoveryMail } : {}), webhooks: readWebhookConfig(), ...(agentChat ? { agentChat } : {}) });
let closing = false;

async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await app.close();
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  await app.listen(config);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await shutdown();
}
