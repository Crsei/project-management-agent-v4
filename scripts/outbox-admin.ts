import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { listOutboxFailures, retryFailedOutbox } from '../packages/application/src/outbox-admin.ts';
import type { OutboxRetry } from '../packages/application/src/outbox-admin.ts';
import { DomainError } from '../packages/domain/src/core.ts';
import { createPool } from '../packages/infrastructure/src/database.ts';

const usage = 'Usage: outbox-admin.ts failed|retry --workspace UUID';

async function openPrivateAuditLog(): Promise<FileHandle> {
  if (process.platform !== 'linux') throw new DomainError('audit_storage_unavailable', 'Operator audit logging requires Linux');
  const localPath = fileURLToPath(new URL('../.local/', import.meta.url));
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  await mkdir(localPath, { recursive: true, mode: 0o700 });
  const local = await open(localPath, directoryFlags);
  let logs: FileHandle | undefined;
  let file: FileHandle | undefined;
  try {
    await local.chmod(0o700);
    const logsPath = `/proc/self/fd/${local.fd}/logs`;
    try { await mkdir(logsPath, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    logs = await open(logsPath, directoryFlags);
    await logs.chmod(0o700);
    file = await open(`/proc/self/fd/${logs.fd}/outbox-maintenance.ndjson`, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new DomainError('audit_storage_unavailable', 'Audit destination must be a private regular file');
    await file.chmod(0o600);
    await file.sync();
    await logs.sync();
    await local.sync();
    return file;
  } catch (error) {
    await file?.close().catch(() => undefined);
    throw error;
  } finally {
    await logs?.close();
    await local.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return; }
  if (args.length !== 3 || !['failed', 'retry'].includes(args[0]!) || args[1] !== '--workspace') throw new DomainError('invalid_arguments', usage);
  const parsed = z.uuid().toLowerCase().safeParse(args[2]);
  if (!parsed.success) throw new DomainError('invalid_arguments', usage);
  if (!process.env.DATABASE_URL) throw new DomainError('database_not_configured', 'DATABASE_URL is required');
  const pool = createPool(process.env.DATABASE_URL);
  let audit: FileHandle | undefined;
  try {
    if (args[0] === 'failed') {
      console.log(JSON.stringify(await listOutboxFailures(pool, parsed.data)));
      return;
    }
    const uid = process.getuid?.();
    if (uid === undefined) throw new DomainError('operator_identity_unavailable');
    audit = await openPrivateAuditLog();
    const append = async (phase: 'prepared' | 'committed', operation: OutboxRetry) => {
      await audit!.appendFile(JSON.stringify({ time: new Date().toISOString(), uid, action: 'retry', phase, ...operation }) + '\n', 'utf8');
      await audit!.sync();
    };
    const result = await retryFailedOutbox(pool, parsed.data, operation => append('prepared', operation));
    await append('committed', result);
    console.log(JSON.stringify(result));
  } finally {
    await audit?.close();
    await pool.end();
  }
}

try { await main(); }
catch (error) {
  // PostgreSQL and filesystem errors can contain connection or private path data.
  const code = error instanceof DomainError ? error.code : 'outbox_maintenance_failed';
  console.error(JSON.stringify({ error: { code, ...(code === 'invalid_arguments' ? { usage } : {}) } }));
  process.exitCode = 1;
}
