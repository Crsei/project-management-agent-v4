import { FileRepository, maxRepositoryFileBytes, RepositoryConflict, revisionOf } from './repository.ts';
import { inspectFrontmatter, inspectMarkdown, parseMarkdown } from '../pm-markdown/index.ts';
import { defaultConfiguration, entityKinds, parseConfiguration, type FileRecord, type ProtocolConfiguration } from '../pm-schema/index.ts';
import type { MigrationTransition } from './migrations.ts';
import type { ProjectDirectoryCheck } from './project-locations.ts';
import type { ProjectCopyMapping } from './project-copy.ts';
import path from 'node:path';

export interface Identity { path: string; id: string; entity?: string }
export interface Idempotency { key: string; hash: string; id: string; revision?: string; copy?: ProjectCopyMapping & { sourceRevision: string; records: { id: string; revision: string }[] } }
export type DuplicateTransaction = { kind: 'duplicate'; id: string; path: string; raw: string; records: { id: string; path: string; raw: string }[]; idempotency: Idempotency & { copy: NonNullable<Idempotency['copy']> }; projectDirectory?: { workspaceId: string; hash: string; check: ProjectDirectoryCheck }; mutationIds?: string[] };
export type Transaction =
  | { kind: 'create'; id: string; path: string; raw: string; idempotency?: Idempotency; projectDirectory?: { workspaceId: string; hash: string; check: ProjectDirectoryCheck }; mutationId?: string }
  | DuplicateTransaction
  | { kind: 'write'; id: string; path: string; raw: string; beforeRevision: string; mutationId: string; idempotency?: never }
  | { kind: 'delete'; id: string; path: string; raw: string; mutationId?: string };
interface ProjectionBlob { revision: string; bytes: number; parts: number }
export interface MigrationProjection {
  version: 1;
  configuration: string;
  configurations: Record<string, ProjectionBlob>;
  configurationRevision: string;
  transitions: MigrationTransition[];
  sources: { path: string; revision: string; content: ProjectionBlob; configuration: string }[];
  checksum: string;
}
interface State {
  version: 1;
  reservedIds: string[];
  observed: Identity[];
  tombstones: string[];
  idempotency: Idempotency[];
  committedMutationIds?: string[];
  transaction?: Transaction;
  migrationProjection?: MigrationProjection;
}
const statePath = '.pm/state/state.json';
const projectionBlobDirectory = '.pm/state/projection-blobs';
const projectionChunkLength = 256 * 1024;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9]*-\d+$/.test(value);
const mutationIdentity = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const safePath = (value: unknown): value is string => typeof value === 'string' && !value.startsWith('.pm/') && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => !!part && part !== '..' && part !== '.') && /\.md$/i.test(value);
const keyRecord = (value: unknown): value is Idempotency => object(value) && typeof value.key === 'string' && !!value.key && typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash) && id(value.id)
  && (value.revision === undefined || typeof value.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision))
  && (value.copy === undefined || object(value.copy) && id(value.copy.sourceProjectId) && typeof value.copy.sourceRevision === 'string' && /^[a-f0-9]{64}$/.test(value.copy.sourceRevision) && object(value.copy.taskIdMap)
    && Object.entries(value.copy.taskIdMap).every(([source, target]) => id(source) && id(target))
    && value.copy.copiedTaskCount === Object.keys(value.copy.taskIdMap).length && Array.isArray(value.copy.records)
    && value.copy.records.every(record => object(record) && id(record.id) && typeof record.revision === 'string' && /^[a-f0-9]{64}$/.test(record.revision)));

function validateMigrationProjection(input: unknown): asserts input is MigrationProjection {
  const revision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const blob = (value: unknown): value is ProjectionBlob => object(value) && revision(value.revision)
    && Number.isSafeInteger(value.bytes) && Number(value.bytes) >= 0 && Number.isSafeInteger(value.parts) && Number(value.parts) > 0
    && Number(value.parts) <= Math.max(1, Math.ceil(Number(value.bytes) / (projectionChunkLength - 1)));
  if (!object(input) || input.version !== 1 || !revision(input.configuration) || !object(input.configurations)
    || input.configurationRevision !== 'absent' && !revision(input.configurationRevision)
    || !Array.isArray(input.transitions) || !input.transitions.length || !Array.isArray(input.sources) || !revision(input.checksum))
    throw new Error('Malformed migration projection journal');
  const { checksum, ...payload } = input;
  if (requestHash(payload) !== checksum) throw new Error('Migration projection journal checksum mismatch');
  for (const [key, value] of Object.entries(input.configurations)) {
    if (!blob(value) || key !== value.revision) throw new Error('Invalid migration configuration context');
  }
  if (!Object.hasOwn(input.configurations, input.configuration)) throw new Error('Missing migration configuration context');
  const paths = new Set<string>();
  const pairs = new Set<string>();
  for (const transition of input.transitions) {
    if (!object(transition) || transition.path !== '.pm/config.yaml' && !safePath(transition.path)
      || !(revision(transition.fromRevision) || transition.path === '.pm/config.yaml' && transition.fromRevision === 'absent')
      || !(revision(transition.toRevision) || transition.path === '.pm/config.yaml' && transition.toRevision === 'absent')
      || transition.fromRevision === transition.toRevision) throw new Error('Invalid migration projection transition');
    const key = JSON.stringify([transition.path, transition.fromRevision, transition.toRevision]);
    if (pairs.has(key)) throw new Error('Duplicate migration projection transition');
    pairs.add(key);
    if (transition.path !== '.pm/config.yaml') paths.add(transition.path as string);
  }
  for (const source of input.sources) {
    if (!object(source) || !safePath(source.path) || !paths.delete(source.path) || !blob(source.content)
      || source.content.bytes > maxRepositoryFileBytes || source.revision !== source.content.revision
      || !revision(source.configuration) || !Object.hasOwn(input.configurations, source.configuration))
      throw new Error('Invalid migration projection source');
  }
  if (paths.size) throw new Error('Missing migration projection source baseline');
}

/** Protocol state, never disposable cache. One pending transaction is sufficient for serialized commands. */
export class DurableState {
  private value: State;
  private revision: string;
  private repository: FileRepository;

  constructor(repository: FileRepository, readOnly = false) {
    this.repository = repository;
    let raw: string;
    try { raw = repository.read(statePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const initial: State = { version: 1, reservedIds: [], observed: [], tombstones: [], idempotency: [] };
      raw = JSON.stringify(initial, null, 2) + '\n';
      if (!readOnly) repository.write(statePath, raw);
    }
    const value: unknown = JSON.parse(raw);
    if (!object(value) || value.version !== 1 || !Array.isArray(value.reservedIds) || !value.reservedIds.every(id)
      || !Array.isArray(value.tombstones) || !value.tombstones.every(id)
      || !Array.isArray(value.observed) || !value.observed.every(item => object(item) && safePath(item.path) && id(item.id)
        && (item.entity === undefined || entityKinds.includes(item.entity as typeof entityKinds[number])))
      || !Array.isArray(value.idempotency) || !value.idempotency.every(keyRecord)) throw new Error('Malformed durable protocol state');
    const transaction = value.transaction;
    if (transaction !== undefined && (!object(transaction) || !['create', 'delete', 'duplicate', 'write'].includes(String(transaction.kind)) || !id(transaction.id)
      || !safePath(transaction.path) || typeof transaction.raw !== 'string'
      || (transaction.idempotency !== undefined && !keyRecord(transaction.idempotency)))) throw new Error('Malformed durable transaction');
    if (object(transaction) && transaction.kind === 'write' && (typeof transaction.beforeRevision !== 'string' || !/^[a-f0-9]{64}$/.test(transaction.beforeRevision) || !mutationIdentity(transaction.mutationId))) throw new Error('Malformed durable write proof');
    if (object(transaction) && transaction.mutationId !== undefined && !mutationIdentity(transaction.mutationId)) throw new Error('Malformed durable mutation proof');
    if (object(transaction) && transaction.mutationIds !== undefined && (transaction.kind !== 'duplicate' || !Array.isArray(transaction.mutationIds) || !transaction.mutationIds.every(mutationIdentity))) throw new Error('Malformed durable batch proof');
    if (value.committedMutationIds !== undefined && (!Array.isArray(value.committedMutationIds) || !value.committedMutationIds.every(mutationIdentity))) throw new Error('Malformed committed mutation proof');
    if (object(transaction) && transaction.projectDirectory !== undefined) {
      const directory = transaction.projectDirectory;
      const rootIdentity = (item: unknown): boolean => object(item) && typeof item.device === 'string' && /^\d+$/.test(item.device) && typeof item.inode === 'string' && /^\d+$/.test(item.inode);
      if (!['create', 'duplicate'].includes(String(transaction.kind)) || !object(directory) || typeof directory.workspaceId !== 'string' || !directory.workspaceId
        || typeof directory.hash !== 'string' || !/^[a-f0-9]{64}$/.test(directory.hash) || !object(directory.check)
        || typeof directory.check.root !== 'string' || !path.isAbsolute(directory.check.root) || path.resolve(directory.check.root) !== directory.check.root
        || !['existing', 'new'].includes(String(directory.check.mode))
        || (directory.check.mode === 'existing' ? !rootIdentity(directory.check.identity) : !rootIdentity(directory.check.parentIdentity))
        || transaction.path !== `project-roots/${String(transaction.id)}/projects/${String(transaction.id)}.md`) throw new Error('Malformed durable project directory reservation');
    }
    if (object(transaction) && transaction.kind === 'duplicate') {
      const request = transaction.idempotency;
      if (!keyRecord(request) || !request.copy || !Array.isArray(transaction.records)) throw new Error('Malformed durable project copy');
      const copy = request.copy;
      const expectedIds = new Set([transaction.id, ...Object.values(copy.taskIdMap)]);
      const prefix = transaction.projectDirectory ? `project-roots/${String(transaction.id)}/` : '';
      if (transaction.records.length !== copy.copiedTaskCount + 1 || expectedIds.size !== transaction.records.length
        || transaction.records.some(record => !object(record) || !id(record.id) || !expectedIds.has(record.id) || !safePath(record.path) || typeof record.raw !== 'string'
          || record.path !== `${prefix}${record.id === transaction.id ? 'projects' : 'work-items'}/${record.id}.md`
          || inspectMarkdown(record.raw).id !== record.id || !copy.records.some(proof => proof.id === record.id && typeof record.raw === 'string' && proof.revision === revisionOf(record.raw)))
        || new Set(transaction.records.map(record => object(record) ? record.id : undefined)).size !== transaction.records.length
        || !transaction.records.some(record => object(record) && record.id === transaction.id && record.path === transaction.path && record.raw === transaction.raw))
        throw new Error('Malformed durable project copy');
    }
    this.value = value as unknown as State;
    if (new Set(this.value.observed.map(item => item.path)).size !== this.value.observed.length
      || new Set(this.value.idempotency.map(item => item.key)).size !== this.value.idempotency.length
      || [...this.value.tombstones, ...this.value.observed.map(item => item.id), ...this.value.idempotency.flatMap(item => [item.id, ...(item.copy?.records.map(record => record.id) ?? [])]), ...(this.value.transaction ? [this.value.transaction.id, ...(this.value.transaction.kind === 'duplicate' ? this.value.transaction.records.map(record => record.id) : [])] : [])].some(item => !this.value.reservedIds.includes(item))) throw new Error('Inconsistent durable protocol state');
    if (this.value.transaction && this.value.transaction.kind !== 'delete' && this.value.transaction.idempotency && this.value.transaction.idempotency.id !== this.value.transaction.id) throw new Error('Inconsistent durable idempotency transaction');
    if (this.value.transaction) {
      const pending = this.value.transaction;
      const identity = inspectMarkdown(pending.raw);
      const { metadata } = inspectFrontmatter(pending.raw);
      if (identity.id !== pending.id || identity.schema !== 'pm/v1' || !identity.title || !entityKinds.includes(metadata.entity as typeof entityKinds[number]) || this.value.tombstones.includes(pending.id)
        || this.value.observed.some(item => item.path === pending.path && (item.id !== pending.id || item.entity !== undefined && item.entity !== metadata.entity))
        || pending.kind !== 'delete' && pending.idempotency && this.value.idempotency.some(item => item.key === pending.idempotency!.key)) throw new Error('Inconsistent durable transaction identity');
    }
    if (this.value.migrationProjection !== undefined) {
      if (this.value.transaction) throw new Error('Conflicting durable lifecycle and migration projection journals');
      validateMigrationProjection(this.value.migrationProjection);
      this.migrationConfiguration();
      for (const _baseline of this.migrationBaselines()) { /* Validate payloads incrementally without retaining aggregate source bytes. */ }
    }
    this.revision = revisionOf(raw);
  }

  get ids(): readonly string[] { return this.value.reservedIds; }
  get transaction(): Transaction | undefined { return this.value.transaction; }
  identity(path: string): Identity | undefined { return this.value.observed.find(item => item.path === path); }
  deleted(id: string): boolean { return this.value.tombstones.includes(id); }
  request(key: string): Idempotency | undefined { return this.value.idempotency.find(item => item.key === key); }
  get migrationProjection(): MigrationProjection | undefined { return this.value.migrationProjection; }

  private writeProjectionBlob(raw: string): ProjectionBlob {
    const revision = revisionOf(raw);
    this.repository.mkdir(projectionBlobDirectory);
    let index = 0;
    for (let offset = 0; offset < raw.length || index === 0;) {
      let end = Math.min(raw.length, offset + projectionChunkLength);
      if (end < raw.length && /[\uD800-\uDBFF]/.test(raw[end - 1]!) && /[\uDC00-\uDFFF]/.test(raw[end]!)) end--;
      const chunk = raw.slice(offset, end);
      const path = `${projectionBlobDirectory}/${revision}-${index}.txt`;
      try {
        if (this.repository.read(path) !== chunk) throw new Error('Migration projection blob checksum mismatch');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.repository.write(path, chunk);
      }
      offset = end;
      index++;
    }
    return { revision, bytes: Buffer.byteLength(raw, 'utf8'), parts: index };
  }

  private readProjectionBlob(blob: ProjectionBlob): string {
    const chunks: string[] = [];
    let bytes = 0;
    for (let index = 0; index < blob.parts; index++) {
      const chunk = this.repository.read(`${projectionBlobDirectory}/${blob.revision}-${index}.txt`);
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (chunk.length > projectionChunkLength || bytes > blob.bytes) throw new Error('Invalid migration projection blob size');
      chunks.push(chunk);
    }
    const raw = chunks.join('');
    if (bytes !== blob.bytes || revisionOf(raw) !== blob.revision) throw new Error('Migration projection blob checksum mismatch');
    return raw;
  }

  migrationConfiguration(): ProtocolConfiguration | undefined {
    const journal = this.value.migrationProjection;
    return journal ? parseConfiguration(JSON.parse(this.readProjectionBlob(journal.configurations[journal.configuration]!))) : undefined;
  }

  private *projectionBaselines(journal: MigrationProjection): Generator<FileRecord> {
    const configurations = new Map<string, ProtocolConfiguration>();
    for (const source of journal.sources) {
      let configuration = configurations.get(source.configuration);
      if (!configuration) {
        configuration = parseConfiguration(JSON.parse(this.readProjectionBlob(journal.configurations[source.configuration]!)));
        configurations.set(source.configuration, configuration);
      }
      const raw = this.readProjectionBlob(source.content);
      const entity = parseMarkdown(raw, configuration);
      const identity = this.identity(source.path);
      if (!this.value.reservedIds.includes(entity.id) || this.value.tombstones.includes(entity.id)
        || !identity || identity.id !== entity.id || identity.entity !== entity.entity)
        throw new Error('Inconsistent migration projection identity');
      yield { id: entity.id, path: source.path, raw, revision: source.revision, entity };
    }
  }

  *migrationBaselines(): Generator<FileRecord> {
    if (this.value.migrationProjection) yield* this.projectionBaselines(this.value.migrationProjection);
  }

  stageMigrationProjection(transitions: readonly MigrationTransition[], files: FileRecord[], configuration: ProtocolConfiguration, configurationRevision: string): void {
    if (this.value.transaction) throw new Error('An unresolved lifecycle transaction blocks projection retirement');
    const pairs = new Map((this.value.migrationProjection?.transitions ?? []).map(transition => [JSON.stringify([transition.path, transition.fromRevision, transition.toRevision]), transition]));
    for (const transition of transitions) pairs.set(JSON.stringify([transition.path, transition.fromRevision, transition.toRevision]), transition);
    const configurationBlob = this.writeProjectionBlob(JSON.stringify(configuration));
    const configurations = { ...this.value.migrationProjection?.configurations, [configurationBlob.revision]: configurationBlob };
    const sources = new Map((this.value.migrationProjection?.sources ?? []).map(source => [source.path, source]));
    const paths = new Set([...pairs.values()].map(transition => transition.path));
    const byPath = new Map(files.map(file => [file.path, file]));
    const byId = new Map(files.map(file => [file.id, file]));
    for (const path of paths) {
      const observed = this.identity(path);
      const file = byPath.get(path) ?? (observed ? byId.get(observed.id) : undefined);
      if (file && !file.stale) sources.set(path, { path, revision: file.revision, content: this.writeProjectionBlob(file.raw), configuration: configurationBlob.revision });
    }
    const payload = { version: 1 as const, configuration: configurationBlob.revision, configurations, configurationRevision, transitions: [...pairs.values()], sources: [...sources.values()] };
    const journal = { ...payload, checksum: requestHash(payload) };
    validateMigrationProjection(journal);
    for (const _baseline of this.projectionBaselines(journal)) { /* Validate each blob before publishing its reference. */ }
    if (journal.checksum !== this.value.migrationProjection?.checksum) this.store({ ...this.value, migrationProjection: journal });
  }

  finishMigrationProjection(): void {
    if (!this.value.migrationProjection) return;
    const { migrationProjection: _projection, ...next } = this.value;
    this.store(next);
  }

  private store(next: State): void {
    const raw = JSON.stringify(next, null, 2) + '\n';
    this.repository.write(statePath, raw, this.revision);
    this.value = next;
    this.revision = revisionOf(raw);
  }

  observe(ids: Iterable<string>, identities: Identity[]): void {
    if (revisionOf(this.repository.read(statePath)) !== this.revision) throw new Error('Durable protocol state changed outside this process');
    const reservedIds = new Set(this.value.reservedIds);
    for (const value of ids) if (id(value)) reservedIds.add(value);
    const observed = new Map(this.value.observed.map(item => [item.path, item]));
    for (const identity of identities) {
      const previous = observed.get(identity.path);
      if (!previous || previous.id === identity.id && !previous.entity && identity.entity) observed.set(identity.path, identity);
    }
    if (reservedIds.size !== this.value.reservedIds.length || JSON.stringify([...observed.values()]) !== JSON.stringify(this.value.observed)) {
      this.store({ ...this.value, reservedIds: [...reservedIds], observed: [...observed.values()] });
    }
  }

  begin(transaction: Transaction): void {
    if (this.value.transaction) throw new Error('An unresolved durable transaction blocks mutations');
    if (this.value.migrationProjection) throw new Error('An unresolved migration projection blocks mutations');
    this.store({ ...this.value, reservedIds: [...new Set([...this.value.reservedIds, transaction.id, ...(transaction.kind === 'duplicate' ? transaction.records.map(record => record.id) : [])])], transaction });
  }

  attachMutationProofs(mutationIds: readonly string[]): void {
    if (!mutationIds.length) return;
    const transaction = this.value.transaction;
    if (transaction?.kind !== 'duplicate') throw new Error('Only the pending project copy may attach batch proofs');
    const next = [...new Set([...(transaction.mutationIds ?? []), ...mutationIds])];
    if (JSON.stringify(next) !== JSON.stringify(transaction.mutationIds)) this.store({ ...this.value, transaction: { ...transaction, mutationIds: next } });
  }

  finish(): void {
    const transaction = this.value.transaction;
    if (!transaction) return;
    const { transaction: _transaction, ...next } = this.value;
    if (transaction.kind === 'delete') next.tombstones = [...new Set([...next.tombstones, transaction.id])];
    else if (transaction.idempotency) next.idempotency = [...next.idempotency, { ...transaction.idempotency, revision: revisionOf(transaction.raw) }];
    const proofs='mutationIds' in transaction?transaction.mutationIds??[]:'mutationId' in transaction&&transaction.mutationId?[transaction.mutationId]:[];
    if (proofs.length) next.committedMutationIds = [...new Set([...(next.committedMutationIds ?? []), ...proofs])];
    this.store(next);
  }

  mutationProofs(): ReadonlySet<string> {
    return new Set(this.value.committedMutationIds ?? []);
  }

  hasUnpublishedMutations(): boolean {
    return !!this.value.committedMutationIds?.length;
  }

  retireMutationProofs(completed: ReadonlySet<string>): void {
    const proofs = this.value.committedMutationIds;
    if (!proofs?.some(id => completed.has(id))) return;
    this.store({ ...this.value, committedMutationIds: proofs.filter(id => !completed.has(id)) });
  }

  cancelUnwrittenMutation(knownCasRejection = false): void {
    const transaction = this.value.transaction;
    if (transaction?.kind !== 'write') return;
    if (!knownCasRejection && revisionOf(this.repository.read(transaction.path)) !== transaction.beforeRevision) return;
    const { transaction: _transaction, ...next } = this.value;
    this.store(next);
  }

  /** Confirm an already published creation only; absence or changed bytes never authorize a file replay. */
  confirmCreation(key: string): void {
    const transaction = this.value.transaction;
    if (transaction?.kind !== 'create' || transaction.idempotency?.key !== key) return;
    let current: string;
    try { current = this.repository.read(transaction.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (current === transaction.raw) this.finish();
  }

  /** Replay only exact intended bytes; never overwrite or delete an external writer's content. */
  recover(configuration: ProtocolConfiguration = defaultConfiguration): void {
    const transaction = this.value.transaction;
    if (!transaction) return;
    if (transaction.kind === 'duplicate') return; // Resume the frozen multi-file operation only through explicit authorized recovery.
    if (parseMarkdown(transaction.raw, configuration).id !== transaction.id) throw new Error('Inconsistent durable transaction identity');
    let current: string | undefined;
    try { current = this.repository.read(transaction.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (transaction.kind === 'write') {
      if (current === transaction.raw) this.finish();
      else if (current !== undefined && revisionOf(current) === transaction.beforeRevision) this.cancelUnwrittenMutation();
      else throw new RepositoryConflict(`Write proof conflicts with external content: ${transaction.path}`);
      return;
    }
    if (current !== undefined && current !== transaction.raw) throw new RepositoryConflict(`Transaction recovery conflicts with external content: ${transaction.path}`);
    if (transaction.kind === 'create' && current === undefined) {
      const directory = transaction.path.slice(0, transaction.path.lastIndexOf('/'));
      if (directory) this.repository.mkdir(directory);
      this.repository.write(transaction.path, transaction.raw);
    }
    if (transaction.kind === 'delete' && current !== undefined) this.repository.remove(transaction.path, revisionOf(transaction.raw));
    this.finish();
  }
  writeDuplicate(configuration: ProtocolConfiguration): void {
    const transaction = this.value.transaction;
    if (transaction?.kind !== 'duplicate') throw new Error('No project copy requires recovery');
    // Check the entire manifest before publishing anything; changed destinations never get overwritten.
    for (const record of transaction.records) {
      if (parseMarkdown(record.raw, configuration).id !== record.id || this.deleted(record.id)) throw new Error('Invalid project copy identity');
      try { if (this.repository.read(record.path) !== record.raw) throw new RepositoryConflict(`Project copy conflicts with external content: ${record.path}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    for (const record of transaction.records) {
      try { this.repository.read(record.path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.repository.mkdir(record.path.slice(0, record.path.lastIndexOf('/')));
        this.repository.write(record.path, record.raw);
      }
    }
  }
}

/** JSON request semantics: key ordering is irrelevant, array ordering and null are significant. */
export function requestHash(input: Record<string, unknown>): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || typeof value === 'number' && !Number.isFinite(value)) throw new Error('Creation input must contain JSON values');
    return value;
  };
  return revisionOf(JSON.stringify(normalize(input)));
}
