import { createAgentBackup, restoreAgentBackup } from '../../../server/agent/src/maintenance/agent-backup.ts';

// Executed with the bundled Node runtime, never inside Electron or an HTTP route.
async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error('Maintenance request is too large.');
  }
  const request = JSON.parse(input) as { operation?: string; source?: string; destination?: string };
  if (typeof request.source !== 'string' || typeof request.destination !== 'string') throw new Error('Maintenance paths are required.');
  if (request.operation === 'backup') {
    const result = await createAgentBackup({ source: request.source, bundle: request.destination, secrets: 'include', stopped: true });
    console.log(JSON.stringify({ coverage: result.coverage }));
  } else if (request.operation === 'restore') {
    const coverage = restoreAgentBackup({ bundle: request.source, target: request.destination, stopped: true });
    console.log(JSON.stringify({ coverage }));
  } else throw new Error('Unknown maintenance operation.');
}

main().catch(() => {
  // Provider configuration and conversation data may occur in nested errors.
  console.error('Private Agent maintenance failed. Original data was not overwritten.');
  process.exitCode = 1;
});
