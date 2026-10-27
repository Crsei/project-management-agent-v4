import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { z } from 'zod';
import { statusCategory, type FileRecord, type ProtocolConfiguration } from '../pm-schema/index.ts';
import { FileRepository, maxRepositoryFileBytes, revisionOf } from './repository.ts';

export type SprintHistorySource = 'startup' | 'external' | 'core_command' | 'scan';
export type SprintHistoryTask = { id: string; projectId: string | null; title: string; status: string | null; category: string | null; archived: boolean; revision: string };
export type SprintHistoryCycle = { id: string; projectId: string | null; title: string; status: string | null; category: string | null; startDate: string | null; dueDate: string | null; archived: boolean; revision: string; tasks: SprintHistoryTask[] };
export type SprintObservation = {
  sequence: number; observedAt: string; source: SprintHistorySource; reason: string; sessionId: string;
  previousObservedAt: string | null; gap: 'initial' | 'restart' | 'invalid_scan' | null;
  complete: boolean; invalidRecordIds: string[]; cycles: SprintHistoryCycle[];
};
export type SprintHistorySnapshot = { status: 'ok' | 'error'; error: string | null; observations: SprintObservation[]; semantics: 'observed_snapshots' };

const directory = '.pm/state/sprint-history';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
const common = { id, projectId: id.nullable(), title: z.string(), status: z.string().nullable(), category: z.string().nullable(), archived: z.boolean(), revision: hash };
const taskSchema = z.strictObject(common);
const cycleSchema = z.strictObject({ ...common, startDate: z.iso.date().nullable(), dueDate: z.iso.date().nullable(), tasks: z.array(taskSchema) });
const observationSchema = z.strictObject({
  sequence: z.number().int().positive().safe(), observedAt: z.iso.datetime(), source: z.enum(['startup', 'external', 'core_command', 'scan']), reason: z.string(), sessionId: z.uuid(),
  previousObservedAt: z.iso.datetime().nullable(), gap: z.enum(['initial', 'restart', 'invalid_scan']).nullable(),
  complete: z.boolean(), invalidRecordIds: z.array(id), cycles: z.array(cycleSchema),
});
const entrySchema = z.strictObject({ version: z.literal(1), previousChecksum: hash.nullable(), observation: observationSchema, checksum: hash });
const checkpointPath = '.pm/state/sprint-history.json';
const checkpointSchema = z.strictObject({ version: z.literal(1), sequence: z.number().int().nonnegative().safe(), entryChecksum: hash.nullable() });
type HistoryEntry = z.infer<typeof entrySchema>;
const filename = (sequence: number) => `${String(sequence).padStart(16, '0')}.json`;
const sourceOf = (reason: string): SprintHistorySource => reason === 'startup' ? 'startup' : reason === 'external' ? 'external' : reason === 'command' ? 'core_command' : 'scan';
const contentOf = (observation: SprintObservation) => JSON.stringify({ complete: observation.complete, invalidRecordIds: observation.invalidRecordIds, cycles: observation.cycles });

/** Immutable, checksum-chained observations live beside durable protocol state, never in SQLite.
 * An observation is published atomically before its CAS checkpoint. Startup can finish that
 * single pending checkpoint; a missing committed tail or malformed chain is a visible error.
 * This journal does not make cycle/task mutations into a multi-file atomic transaction. */
export class SprintHistory {
  private readonly sessionId = randomUUID();
  private entries: HistoryEntry[] = [];
  private error: string | null = null;
  private startupObserved = false;
  private checkpointRevision = '';
  private readonly repository: FileRepository;

  constructor(repository: FileRepository) {
    this.repository = repository;
    try {
      repository.mkdir(directory);
      try { repository.read(checkpointPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (readdirSync(repository.resolve(directory)).length) throw new Error('Sprint history checkpoint is missing');
        repository.write(checkpointPath, JSON.stringify({ version: 1, sequence: 0, entryChecksum: null }) + '\n');
      }
      this.reload();
    } catch (error) { this.fail(error); }
  }

  private fail(error: unknown): void { this.error = error instanceof Error ? error.message : String(error); }

  private reload(): void {
    const checkpointRaw = this.repository.read(checkpointPath);
    const checkpoint = checkpointSchema.parse(JSON.parse(checkpointRaw));
    this.checkpointRevision = revisionOf(checkpointRaw);
    const names = readdirSync(this.repository.resolve(directory)).sort();
    const entries: HistoryEntry[] = [];
    this.entries = entries;
    for (const [index, name] of names.entries()) {
      if (name !== filename(index + 1)) throw new Error(`Sprint history sequence is missing or contains an unexpected file at ${index + 1}`);
      const entry: HistoryEntry = JSON.parse(this.repository.read(`${directory}/${name}`));
      // Validate without replacing the stored object: schema parsing reorders cycle keys,
      // which would change its checksum and snapshot equality despite unchanged content.
      entrySchema.parse(entry);
      const { checksum, ...payload } = entry;
      const previous = entries.at(-1);
      if (revisionOf(JSON.stringify(payload)) !== checksum || entry.observation.sequence !== index + 1
        || entry.previousChecksum !== (previous?.checksum ?? null)
        || entry.observation.previousObservedAt !== (previous?.observation.observedAt ?? null)
        || !previous && entry.observation.gap !== 'initial') throw new Error(`Sprint history integrity failed at observation ${index + 1}`);
      if (new Set(entry.observation.cycles.map(cycle => cycle.id)).size !== entry.observation.cycles.length
        || entry.observation.cycles.some(cycle => new Set(cycle.tasks.map(task => task.id)).size !== cycle.tasks.length
          || cycle.tasks.some(task => task.projectId !== cycle.projectId))) throw new Error(`Sprint history membership is invalid at observation ${index + 1}`);
      entries.push(entry);
    }
    if (checkpoint.sequence > entries.length || checkpoint.sequence < entries.length - 1
      || checkpoint.entryChecksum !== (entries[checkpoint.sequence - 1]?.checksum ?? null)) throw new Error('Committed sprint history is missing or its checkpoint is inconsistent');
    if (checkpoint.sequence < entries.length) this.checkpoint();
    this.error = null;
  }

  private checkpoint(): void {
    const entry = this.entries.at(-1);
    const raw = JSON.stringify({ version: 1, sequence: this.entries.length, entryChecksum: entry?.checksum ?? null }) + '\n';
    this.repository.write(checkpointPath, raw, this.checkpointRevision);
    this.checkpointRevision = revisionOf(raw);
  }

  observe(files: readonly FileRecord[], configuration: ProtocolConfiguration, reason: string, globallyValid: boolean): void {
    if (this.error) return;
    try {
      // Detect concurrent writers, removed tails and unexpected state files before publication.
      const names = readdirSync(this.repository.resolve(directory)).sort();
      if (revisionOf(this.repository.read(checkpointPath)) !== this.checkpointRevision || names.length !== this.entries.length || names.some((name, index) => name !== filename(index + 1))) {
        const previous = this.entries.at(-1)?.checksum;
        this.reload();
        if (previous && !this.entries.some(entry => entry.checksum === previous)) throw new Error('Previously observed sprint history was removed or replaced');
      }
      const invalid = files.filter(file => file.stale || file.diagnostics?.some(issue => issue.severity === 'error'));
      const valid = files.filter(file => !invalid.includes(file));
      const cycles: SprintHistoryCycle[] = valid.filter(file => file.entity.entity === 'cycle').map(file => ({
        id: file.id, projectId: file.entity.project ?? null, title: file.entity.title, status: file.entity.status ?? null,
        category: statusCategory(file.entity, configuration) ?? null, startDate: file.entity.start ?? null, dueDate: file.entity.due ?? null,
        archived: file.entity.archived === true, revision: file.revision,
        tasks: valid.filter(task => task.entity.entity === 'work_item' && task.entity.cycle === file.id).map(task => ({
          id: task.id, projectId: task.entity.project ?? null, title: task.entity.title, status: task.entity.status ?? null,
          category: statusCategory(task.entity, configuration) ?? null, archived: task.entity.archived === true, revision: task.revision,
        })).sort((left, right) => left.id.localeCompare(right.id)),
      })).sort((left, right) => left.id.localeCompare(right.id));
      const previous = this.entries.at(-1);
      const observation: SprintObservation = {
        sequence: this.entries.length + 1, observedAt: new Date().toISOString(), source: sourceOf(reason), reason, sessionId: this.sessionId,
        previousObservedAt: previous?.observation.observedAt ?? null,
        gap: !previous ? 'initial' : !this.startupObserved && reason === 'startup' ? 'restart' : !previous.observation.complete ? 'invalid_scan' : null,
        complete: globallyValid && invalid.length === 0, invalidRecordIds: invalid.map(file => file.id).sort(), cycles: globallyValid ? cycles : [],
      };
      if (previous && contentOf(previous.observation) === contentOf(observation) && (reason !== 'startup' || this.startupObserved)) return;
      const payload = { version: 1 as const, previousChecksum: previous?.checksum ?? null, observation };
      const entry: HistoryEntry = { ...payload, checksum: revisionOf(JSON.stringify(payload)) };
      const raw = JSON.stringify(entry) + '\n';
      if (Buffer.byteLength(raw, 'utf8') > maxRepositoryFileBytes) throw new Error('Sprint observation exceeds the durable history file limit');
      this.repository.write(`${directory}/${filename(observation.sequence)}`, raw);
      this.entries.push(entry);
      this.checkpoint();
      if (reason === 'startup') this.startupObserved = true;
    } catch (error) { this.fail(error); }
  }

  failure(): string | null { return this.error; }

  snapshot(): SprintHistorySnapshot {
    if (!this.error) {
      const previous = this.entries.at(-1)?.checksum;
      try {
        this.reload();
        if (previous && !this.entries.some(entry => entry.checksum === previous)) throw new Error('Previously observed sprint history was removed or replaced');
      } catch (error) { this.fail(error); }
    }
    return { status: this.error ? 'error' : 'ok', error: this.error, observations: structuredClone(this.entries.map(entry => entry.observation)), semantics: 'observed_snapshots' };
  }
}
