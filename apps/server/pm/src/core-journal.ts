import { appendFileSync, closeSync, constants, existsSync, fstatSync, fsyncSync, openSync } from 'node:fs';
import path from 'node:path';
import type { Command, CommandReceipt } from '../../../../packages/domain/src/core.ts';
import { z } from 'zod';
import { projectAuditWriteSchema, type ProjectAuditWrite } from '../../../../packages/application/src/project-audit.ts';
import { capturedServiceFactSchema, type CapturedServiceFact } from '../../../../packages/application/src/service-facts.ts';
import { summarySchema, type CoreFactSummary } from '../../../../packages/pm-core/service-facts.ts';
import { FileRepository } from '../../../../packages/pm-core/repository.ts';
const journalPath = '.pm/state/pm-command-journal.ndjson';

type Pending = { kind: 'pending'; commandId: string; actorId: string; hash: string; commandType: string; command?: Command; copyAudit?: readonly ProjectAuditWrite[] };
type Completed = { kind: 'completed'; commandId: string; actorId: string; hash: string; receipt: CommandReceipt; scopeProjectIds?: string[]; audit?: readonly ProjectAuditWrite[]; facts?: readonly CapturedServiceFact[] | undefined };
export type CoreHttpCreation = { coreKey: string; inputHash: string; scopeProjectIds: string[]; prepared?: { targetId: string; revision: string; audit: readonly ProjectAuditWrite[] } };
export type CoreHttpAuditCompleted = { kind: 'http_completed'; commandId: string; actorId: string; hash: string; targetId: string; revision: string | null; audit: readonly ProjectAuditWrite[]; creation?: CoreHttpCreation; facts?: readonly CapturedServiceFact[] | undefined };
export type CoreHttpAuditPending = { kind: 'http_pending'; commandId: string; actorId: string; hash: string; creation?: CoreHttpCreation };
export type CoreHttpAuditRejected = { kind: 'http_rejected'; commandId: string; actorId: string; hash: string; creation?: CoreHttpCreation };
export type CoreHttpOutcome = CoreHttpAuditPending | CoreHttpAuditCompleted | CoreHttpAuditRejected;
type FactEntry = { kind: 'fact_prepared' | 'fact_completed'; commandId: string; actorId: string; hash: string; captured: CapturedServiceFact; boundary?: { before: CoreFactSummary | null; after: CoreFactSummary | null } | undefined };
type Entry = Pending | Completed | CoreHttpOutcome | FactEntry;
const identity = z.object({ commandId: z.string().min(1).max(128), actorId: z.uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/) });
const receiptSchema = z.object({
  commandId: z.uuid(), status: z.enum(['committed', 'rejected']), httpStatus: z.number().int().min(100).max(599), result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).strict().optional(),
}).strict();
const creationSchema = z.object({
  coreKey: z.string().min(1).max(512), inputHash: z.string().regex(/^[a-f0-9]{64}$/), scopeProjectIds: z.array(z.string()),
  prepared: z.object({ targetId: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/), audit: z.array(projectAuditWriteSchema) }).strict().optional(),
}).strict();
const commandSchema = z.strictObject({
  commandId: z.uuid(), commandType: z.string(), targetId: z.string().optional(), projectId: z.string().optional(),
  expectedVersions: z.record(z.string(), z.number().int().positive()).optional(), payload: z.record(z.string(), z.unknown()),
});
const entrySchema = z.discriminatedUnion('kind', [
  identity.extend({ kind: z.literal('pending'), commandType: z.string(), command: commandSchema.optional(), copyAudit: z.array(projectAuditWriteSchema).optional() }).strict(),
  identity.extend({ kind: z.literal('completed'), receipt: receiptSchema, scopeProjectIds: z.array(z.string()).optional(), audit: z.array(projectAuditWriteSchema).optional(), facts: z.array(capturedServiceFactSchema).optional() }).strict(),
  identity.extend({ kind: z.literal('http_pending'), creation: creationSchema.optional() }).strict(),
  identity.extend({ kind: z.literal('http_rejected'), creation: creationSchema.optional() }).strict(),
  identity.extend({ kind: z.literal('http_completed'), targetId: z.string().min(1).max(80), revision: z.string().nullable(), audit: z.array(projectAuditWriteSchema), creation: creationSchema.optional(), facts: z.array(capturedServiceFactSchema).optional() }).strict(),
  identity.extend({ kind: z.literal('fact_prepared'), captured: capturedServiceFactSchema, boundary: z.strictObject({ before: summarySchema.nullable(), after: summarySchema.nullable() }).optional() }).strict(),
  identity.extend({ kind: z.literal('fact_completed'), captured: capturedServiceFactSchema, boundary: z.strictObject({ before: summarySchema.nullable(), after: summarySchema.nullable() }).optional() }).strict(),
]).transform((entry): Entry => {
  if (entry.kind === 'pending') {
    const command = entry.command;
    return { kind: 'pending', commandId: entry.commandId, actorId: entry.actorId, hash: entry.hash, commandType: entry.commandType,
      ...(entry.copyAudit ? { copyAudit: entry.copyAudit } : {}),
      ...(command ? { command: { commandId: command.commandId, commandType: command.commandType, payload: command.payload,
        ...(command.targetId === undefined ? {} : { targetId: command.targetId }),
        ...(command.projectId === undefined ? {} : { projectId: command.projectId }),
        ...(command.expectedVersions === undefined ? {} : { expectedVersions: command.expectedVersions }) } } : {}) };
  }
  if (entry.kind === 'http_pending' || entry.kind === 'http_rejected' || entry.kind === 'http_completed') {
    const { creation, ...fields } = entry;
    return { ...fields, ...(creation ? { creation: { coreKey: creation.coreKey, inputHash: creation.inputHash,
      scopeProjectIds: creation.scopeProjectIds, ...(creation.prepared ? { prepared: creation.prepared } : {}) } } : {}) };
  }
  if (entry.kind !== 'completed') return entry;
  const { scopeProjectIds, audit, receipt, ...fields } = entry;
  const { error, ...receiptFields } = receipt;
  return {
    ...fields,
    receipt: { ...receiptFields, ...(error === undefined ? {} : { error }) },
    ...(scopeProjectIds === undefined ? {} : { scopeProjectIds }),
    ...(audit === undefined ? {} : { audit }),
  };
});

/**
 * Durable side journal for core commands. The Markdown write and the SQL receipt
 * cannot share a transaction. A pending entry distinguishes "outcome unknown" from
 * a genuine rejection; a completed entry lets a lost response be replayed after a
 * process restart. The journal lives in `.pm/state/`, so it is not a disposable cache.
 */
export class CoreCommandJournal {
  private readonly file: string;
  private readonly repository: FileRepository;
  constructor(workspaceRoot: string) {
    this.file = path.join(workspaceRoot, '.pm', 'state', 'pm-command-journal.ndjson');
    this.repository = new FileRepository(workspaceRoot);
  }

  private append(entry: Entry): void {
    this.repository.mkdir('.pm/state');
    const validated = entrySchema.parse(entry);
    const created = !existsSync(this.file);
    // Flush the durable outcome before SQL persistence or a successful response.
    const descriptor = openSync(this.repository.resolve(journalPath, true), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe core fact journal');
      appendFileSync(descriptor, JSON.stringify(validated) + '\n', { encoding: 'utf8' });
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    if (created) {
      const directory = openSync(this.repository.resolve('.pm/state'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  }

  pending(command: Command, hash: string, actorId: string): void {
    const prior = command.commandType === 'DuplicateProject' ? this.find(command.commandId, actorId, hash) : undefined;
    this.append({ kind: 'pending', commandId: command.commandId.toLowerCase(), actorId, hash, commandType: command.commandType,
      ...(command.commandType === 'DuplicateProject' ? { command, ...(prior?.kind === 'pending' && prior.copyAudit ? { copyAudit: prior.copyAudit } : {}) } : {}) });
  }
  prepareCopy(command: Command, hash: string, actorId: string, copyAudit: readonly ProjectAuditWrite[]): void {
    this.append({ kind: 'pending', commandId: command.commandId.toLowerCase(), actorId, hash, commandType: command.commandType, command, copyAudit });
  }

  complete(commandId: string, hash: string, receipt: CommandReceipt, actorId: string, scopeProjectIds: readonly string[] = [], audit: readonly ProjectAuditWrite[] = [], facts: readonly CapturedServiceFact[] = []): void {
    this.append({ kind: 'completed', commandId: commandId.toLowerCase(), actorId, hash, receipt, scopeProjectIds: [...scopeProjectIds], audit, facts });
  }

  pendingHttp(commandId: string, hash: string, actorId: string, creation?: CoreHttpCreation): void {
    this.append({ kind: 'http_pending', commandId, actorId, hash, ...(creation ? { creation } : {}) });
  }

  completeHttp(entry: Omit<CoreHttpAuditCompleted, 'kind'>): void {
    this.append({ kind: 'http_completed', ...entry });
  }

  rejectHttp(commandId: string, hash: string, actorId: string, creation?: CoreHttpCreation): void {
    this.append({ kind: 'http_rejected', commandId, actorId, hash, ...(creation ? { creation } : {}) });
  }

  fact(kind: FactEntry['kind'], commandId: string, hash: string, actorId: string, captured: CapturedServiceFact, boundary?: FactEntry['boundary']): void {
    this.append({ kind, commandId, hash, actorId, captured, ...(boundary ? { boundary } : {}) });
  }

  entries(): Entry[] {
    if (!existsSync(this.file)) return [];
    return this.repository.read(journalPath).split('\n').filter(Boolean).map(line => entrySchema.parse(JSON.parse(line)));
  }

  httpOutcome(commandId: string, actorId: string): CoreHttpOutcome | undefined {
    if (!existsSync(this.file)) return undefined;
    let match: CoreHttpOutcome | undefined;
    for (const line of this.repository.read(journalPath).split('\n')) {
      if (!line) continue;
      const entry: Entry = entrySchema.parse(JSON.parse(line));
      if (entry.commandId !== commandId || entry.actorId !== actorId || !entry.kind.startsWith('http_')) continue;
      const outcome = entry as CoreHttpOutcome;
      if (match?.kind !== 'http_completed' || outcome.kind === 'http_completed') match = outcome;
    }
    return match;
  }

  findHttp(commandId: string, actorId: string): CoreHttpAuditPending | CoreHttpAuditCompleted | undefined {
    const outcome = this.httpOutcome(commandId, actorId);
    return outcome?.kind === 'http_rejected' ? undefined : outcome;
  }

  find(commandId: string, actorId: string, hash?: string): Completed | Pending | undefined {
    if (!existsSync(this.file)) return undefined;
    const target = commandId.toLowerCase();
    let match: Completed | Pending | undefined;
    for (const line of this.repository.read(journalPath).split('\n')) {
      if (!line) continue;
      const entry: Entry = entrySchema.parse(JSON.parse(line));
      if (entry.commandId !== target || entry.actorId !== actorId || (hash !== undefined && entry.hash !== hash)) continue;
      if (entry.kind === 'completed') match = entry;
      else if (entry.kind === 'pending' && match?.kind !== 'completed') match = entry;
    }
    return match;
  }
}
