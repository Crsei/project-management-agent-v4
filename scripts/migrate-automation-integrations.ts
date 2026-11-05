import { parseArgs } from 'node:util';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../packages/domain/src/core.ts';
import { createPool } from '../packages/infrastructure/src/database.ts';
import { hashCheckpointFile } from '../packages/infrastructure/src/blob-storage-checkpoint.ts';
import { assertStorageRelativePath } from '../packages/infrastructure/src/portable-directory.ts';
import { createAutomationPrivateStore } from '../packages/infrastructure/src/automation-integrations.ts';
import { createAutomationDefinitionClient } from '../packages/infrastructure/src/automation-integrations-definitions.ts';
import { applyAutomationMcpMigration, automationMcpMigrationPlanDigest, automationMcpMigrationPlanSchema, finalizeAutomationMcpMigration, planAutomationMcpMigration, readAutomationMcpMigrationSources, withAutomationMcpMigrationLock } from '../packages/infrastructure/src/automation-integrations-migration.ts';

const args = parseArgs({ allowPositionals: true, strict: true, options: {
  stopped: { type: 'boolean' }, 'dump-file': { type: 'string' }, 'agent-backup-manifest': { type: 'string' },
  output: { type: 'string' }, plan: { type: 'string' }, 'plan-sha256': { type: 'string' },
} });
const command = args.positionals[0];
const usage = 'node scripts/migrate-automation-integrations.ts <dry-run|apply|reconcile|finalize> --stopped --dump-file <matching-pg-dump> --agent-backup-manifest <private-agent-bundle/manifest.json> [--output <new-plan.json> | --plan <plan.json> --plan-sha256 <reviewed-digest>]';
function required(key: keyof typeof args.values): string { const value = args.values[key]; if (typeof value !== 'string' || !value) throw new Error(usage); return value; }
async function readJson(filename: string): Promise<unknown> {
  const absolute = resolve(filename);
  if (await realpath(absolute) !== absolute) throw new Error('Unsafe maintenance metadata path');
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error('Unsafe maintenance metadata'); return JSON.parse(await file.readFile('utf8')) as unknown; }
  finally { await file.close(); }
}
async function writePlan(filename: string, plan: unknown): Promise<void> {
  const absolute = resolve(filename); const parent = dirname(absolute);
  if (await realpath(parent) !== parent) throw new Error('Unsafe plan output directory');
  const file = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(plan, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
const backupManifest = z.object({ format: z.literal('agent-offline-backup'), version: z.literal(1), secrets: z.literal('include'), files: z.array(z.object({ path: z.string().min(1), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })) });
const pool = process.env.DATABASE_URL ? createPool(process.env.DATABASE_URL) : undefined;
try {
  if (!pool || args.positionals.length !== 1 || !['dry-run', 'apply', 'reconcile', 'finalize'].includes(command ?? '')) throw new Error(usage);
  const manifestPath = resolve(required('agent-backup-manifest'));
  if (basename(manifestPath) !== 'manifest.json') throw new Error('Use the completed existing Agent backup bundle manifest.json');
  // Metadata and whole dump hashes only in dry-run: never decrypt or open credential members.
  const manifest = backupManifest.parse(await readJson(manifestPath));
  const snapshots = { sqlDumpSha256: (await hashCheckpointFile(required('dump-file'))).sha256, agentManifestSha256: (await hashCheckpointFile(manifestPath)).sha256 };
  const summary = await withAutomationMcpMigrationLock(pool, args.values.stopped === true, async sql => {
    if (command === 'dry-run') {
      const plan = planAutomationMcpMigration(await readAutomationMcpMigrationSources(sql), snapshots);
      await writePlan(required('output'), plan);
      return { operation: command, planSha256: automationMcpMigrationPlanDigest(plan), connections: plan.entries.length, sameNameConflicts: plan.entries.filter(entry => entry.sameNameConflict).length };
    }
    const plan = automationMcpMigrationPlanSchema.parse(await readJson(required('plan')));
    const expectedPlanDigest = required('plan-sha256');
    if (plan.sqlDumpSha256 !== snapshots.sqlDumpSha256 || plan.agentManifestSha256 !== snapshots.agentManifestSha256) throw new DomainError('integration_migration_snapshot_changed', 'SQL dump or Agent snapshot differs from the reviewed plan', 409);
    // Only explicit migration/reconciliation opens snapshot members, for hashes, never semantic credential reads.
    const seen = new Set<string>(); const root = dirname(manifestPath);
    for (const member of manifest.files) {
      assertStorageRelativePath(member.path);
      if (seen.has(member.path)) throw new Error('Duplicate snapshot member');
      seen.add(member.path); const hash = await hashCheckpointFile(resolve(root, member.path));
      if (hash.sha256 !== member.sha256 || hash.size !== member.bytes) throw new DomainError('integration_migration_snapshot_changed', 'An Agent snapshot member differs from the completed backup', 409);
    }
    const target = createAutomationDefinitionClient();
    if (automationMcpMigrationPlanDigest(plan) !== expectedPlanDigest) throw new DomainError('integration_migration_plan_changed', 'Explicit reviewed migration plan digest differs', 409);
    await target.beginMaintenance(expectedPlanDigest);
    try {
      if (command === 'finalize') {
        // First reconcile the actual managed authority. Finalization cannot trust journal phase alone.
        await applyAutomationMcpMigration(sql, { plan, expectedPlanDigest, target, privateStore: createAutomationPrivateStore(), reconcileOnly: true });
        await finalizeAutomationMcpMigration(sql, plan, expectedPlanDigest);
        return { operation: command, planSha256: expectedPlanDigest, sourcesRemoved: true };
      }
      const result = await applyAutomationMcpMigration(sql, { plan, expectedPlanDigest, target, privateStore: createAutomationPrivateStore(), reconcileOnly: command === 'reconcile' });
      return { operation: command, planSha256: expectedPlanDigest, ...result };
    } finally { await target.endMaintenance(expectedPlanDigest); }
  });
  console.log(JSON.stringify(summary));
} catch (error) {
  // No source config, URL, header, database URL, provider error object or stack may escape.
  console.error(JSON.stringify({ error: error instanceof DomainError ? error.code : 'integration_migration_failed' })); process.exitCode = 1;
} finally { await pool?.end(); }
