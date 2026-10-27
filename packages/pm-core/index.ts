import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import chokidar, { type FSWatcher } from 'chokidar';
import { parseDocument, stringify } from 'yaml';
import { createMarkdown, inspectMarkdown, parseMarkdown, patchMarkdown } from '../pm-markdown/index.ts';
import { defaultConfiguration, diagnosticsOf, entityDefinitions, entityKinds, parseConfiguration, protocolInfo, validateTransition,
  type Diagnostic, type Entity, type EntityKind, type FileRecord, type ProtocolConfiguration, type SavedView, type UnsupportedFile, type ViewConfig, type WorkspaceSnapshot } from '../pm-schema/index.ts';
import { createReferenceResolver, referenceEntries, validateRelations } from '../pm-schema/relations.ts';
import { validateView } from '../pm-schema/query.ts';
import { buildEntityGraph, type GraphData, type GraphQuery } from '../pm-schema/graph.ts';
import { FileRepository, maxRepositoryFileBytes, RepositoryConflict, revisionOf, type RepositoryCollection } from './repository.ts';
import { Projection, type ItemQuery } from './projection.ts';
import { DurableState, requestHash, type Identity } from './state.ts';
import { MigrationManager, type MigrationRequest, type MigrationTransition } from './migrations.ts';
import { SprintHistory, type SprintHistorySnapshot } from './sprint-history.ts';
import { ServiceFactObservations } from './service-facts.ts';
import { ProjectLocations, type ProjectDirectory, type ProjectDirectoryCheck, type ProjectLocation, type ProjectMount } from './project-locations.ts';
import { projectCopyRecords, type ProjectCopyInput, type ProjectCopyResult } from './project-copy.ts';

export { revisionOf } from './repository.ts';
export type { ItemQuery } from './projection.ts';
export { enumerateProjectMounts, readProjectLocation, previewProjectDirectory, rebindProjectLocations } from './project-locations.ts';
export type { ProjectDirectory, ProjectDirectoryCheck, ProjectRootIdentity, ProjectLocation, ProjectMount } from './project-locations.ts';
export type WorkspaceEvent = { type: 'change' | 'error'; reason: string; errors?: Diagnostic[]; message?: string };
export type WorkspaceMutationGuard = (before: FileRecord | undefined, after: Entity, batch?: readonly FileRecord[]) => void | Promise<void>;
export type WorkspaceCreationPrepared = (record: FileRecord) => void;
export type WorkspaceMutationCapture = {
  prepare(before: FileRecord | undefined, after: FileRecord | undefined): Promise<void>;
  committed(before: FileRecord | undefined, after: FileRecord | undefined): string | void;
};
export type CoreCreationFact = { request?: { key: string; hash: string; id: string; revision?: string }; pending: boolean; deleted: boolean; current?: FileRecord; unavailable: boolean };

export class WorkspaceError extends Error {
  readonly status: 400 | 404 | 409 | 422;
  readonly current?: FileRecord | undefined;
  readonly diagnostics: Diagnostic[];
  constructor(status: 400 | 404 | 409 | 422, message: string, current?: FileRecord, diagnostics?: Diagnostic[]) {
    super(message);
    this.name = 'WorkspaceError';
    this.status = status;
    this.current = current;
    this.diagnostics = diagnostics?.length ? diagnostics : [{ code: status === 404 ? 'NOT_FOUND' : status === 409 ? 'REVISION_CONFLICT' : 'VALIDATION_ERROR', severity: 'error', path: current?.path ?? '', message, ...(current ? { entityId: current.id } : {}) }];
  }
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const diagnostic = (code: string, message: string, path = '', entityId?: string, field?: string, targetId?: string): Diagnostic => ({ code, severity: 'error', path, message, ...(entityId ? { entityId } : {}), ...(field ? { field } : {}), ...(targetId ? { targetId } : {}) });
const diagnosticKey = (value: Diagnostic): string => JSON.stringify([value.code, value.path, value.entityId, value.field, value.targetId]);

export class Workspace {
  readonly root: string;
  private repository: FileRepository;
  private projection!: Projection;
  private state!: DurableState;
  private history!: SprintHistory;
  private factHistory!: ServiceFactObservations;
  private readonly mutationCapture = new AsyncLocalStorage<WorkspaceMutationCapture>();
  private watcher?: FSWatcher;
  private events = new EventEmitter();
  private pending: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private initialized = false;
  private fingerprint = '';
  private candidates: FileRecord[] = [];
  private candidateErrors: Diagnostic[] = [];
  private config: ProtocolConfiguration = defaultConfiguration;
  private configRevision = 'absent';
  private acceptedConfigRevision = 'absent';
  private configErrors: Diagnostic[] = [];
  private migrations!: MigrationManager;
  private migrationErrors: Diagnostic[] = [];
  private readonly locations: ProjectLocations;
  private watchedProjectPaths: string[] = [];
  private pendingMigrationAcknowledgments = new Map<string, MigrationTransition>();

  constructor(root: string) {
    this.repository = new FileRepository(root);
    this.root = this.repository.root;
    this.locations = new ProjectLocations(this.root);
    this.events.setMaxListeners(0);
  }

  /** Read durable creation identity and current source without initializing, recovering, or publishing anything. */
  static inspectCreation(root: string, key: string, targetId?: string): CoreCreationFact {
    const repository = new FileRepository(root);
    const state = new DurableState(repository, true);
    const request = state.request(key);
    const transaction = state.transaction;
    const pending = (transaction?.kind === 'create' || transaction?.kind === 'duplicate') && transaction.idempotency?.key === key;
    const id = targetId ?? request?.id;
    const proof = request?.copy?.records.find(record => record.id === id);
    const result: CoreCreationFact = { ...(request ? { request: proof ? { ...request, id: proof.id, revision: proof.revision } : request } : {}), pending, deleted: id ? state.deleted(id) : false, unavailable: false };
    if (!id || result.deleted) return result;
    try {
      let configuration = defaultConfiguration;
      try { configuration = parseConfiguration(parseDocument(repository.read('.pm/config.yaml')).toJS()); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const collection = repository.collect();
      const matches = collection.files.filter(file => inspectMarkdown(file.raw).id === id);
      if (matches.length > 1 || collection.errors.length) return { ...result, unavailable: true };
      const source = matches[0];
      if (source) result.current = { ...source, id, revision: revisionOf(source.raw), entity: parseMarkdown(source.raw, configuration) };
    } catch { result.unavailable = true; }
    return result;
  }

  static confirmCreation(root: string, key: string): void {
    new DurableState(new FileRepository(root), true).confirmCreation(key);
  }

  confirmCreation(key: string): Promise<void> {
    return this.serialize(() => { this.state.confirmCreation(key); });
  }

  async init(afterRecovery?: (facts: ServiceFactObservations) => void): Promise<void> {
    if (this.initialized) return;
    let migrationTransitions: MigrationTransition[] = [];
    try {
      this.repository.init();
      this.state = new DurableState(this.repository);
      this.history = new SprintHistory(this.repository);
      this.factHistory = new ServiceFactObservations(this.repository);
      this.migrations = new MigrationManager(this.repository);
      try {
        this.migrations.recover();
        migrationTransitions = this.migrations.completedTransitions();
      } catch (error) { this.migrationErrors = diagnosticsOf(error); }
      for (const name of ['index.sqlite', 'index.sqlite-journal', 'index.sqlite-wal', 'index.sqlite-shm']) this.repository.resolve(`.pm/cache/${name}`, true);
      this.projection = new Projection(this.repository.resolve('.pm/cache/index.sqlite', true));
      const previous = this.projection.snapshot();
      const retirement = this.state.migrationProjection;
      this.config = this.state.migrationConfiguration() ?? parseConfiguration(previous.configuration);
      // A durable retirement baseline supersedes the disposable projection after an interrupted publication.
      this.acceptedConfigRevision = retirement?.configurationRevision ?? (previous.configurationErrors.length ? '' : previous.configurationRevision);
      this.loadConfiguration(this.repository.collect(), this.projection.hasSnapshot() || retirement !== undefined);
      const transaction = this.state.transaction;
      const localInitialization = transaction?.kind === 'create' && transaction.path === `project-roots/${transaction.id}/projects/${transaction.id}.md` && this.locations.entry(transaction.id)?.status !== 'ready';
      if (!this.configErrors.length && !this.migrationErrors.length && !localInitialization) this.state.recover(this.config);
      afterRecovery?.(this.factHistory);
    } catch (error) {
      this.projection?.close();
      this.closed = true;
      throw new WorkspaceError(error instanceof RepositoryConflict ? 409 : 422, messageOf(error), undefined,
        [diagnostic(error instanceof RepositoryConflict ? 'RECOVERY_CONFLICT' : 'PERSISTENT_STATE_INVALID', messageOf(error), '.pm/state/state.json')]);
    }
    this.scan('startup', migrationTransitions);
    this.watchedProjectPaths = this.locations.watchPaths();
    this.watcher = await this.watchSources(this.watchedProjectPaths);
    this.scan('startup');
    this.initialized = true;
  }

  onChange(listener: (event: WorkspaceEvent) => void): () => void {
    this.events.on('change', listener);
    return () => { this.events.off('change', listener); };
  }
  private notify(event: WorkspaceEvent): void { this.events.emit('change', event); }
  private serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Workspace is closed'));
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
  snapshot(): WorkspaceSnapshot { return this.projection.snapshot(); }
  captureMutations<T>(capture: WorkspaceMutationCapture, operation: () => Promise<T>): Promise<T> {
    return this.mutationCapture.run(capture, operation);
  }
  sprintHistory(): SprintHistorySnapshot { return this.history.snapshot(); }
  items(query: ItemQuery = {}): FileRecord[] { return this.projection.items(query); }
  query(view: ViewConfig, options: { archived?: 'exclude' | 'include' | 'only' } = {}): FileRecord[] {
    try { return this.projection.query(view, options); }
    catch (error) { throw new WorkspaceError(422, messageOf(error), undefined, diagnosticsOf(error)); }
  }
  graph(query: GraphQuery = {}, visible?: (record: FileRecord) => boolean): GraphData {
    const snapshot = this.snapshot();
    if (query.centerId !== undefined && !snapshot.files.some(file => file.id === query.centerId && (!visible || visible(file))))
      throw new WorkspaceError(404, 'Entity is not accessible');
    return buildEntityGraph(snapshot.files, snapshot.configuration, query,
      visible ? { visibleIds: new Set(snapshot.files.filter(visible).map(file => file.id)) } : {});
  }
  configuration(): { config: ProtocolConfiguration; revision: string; diagnostics: Diagnostic[] } {
    return { config: structuredClone(this.config), revision: this.configRevision, diagnostics: structuredClone(this.configErrors) };
  }
  protocol(): Record<string, unknown> {
    return { ...protocolInfo, entityDefinitions, configuration: structuredClone(this.config),
      workflows: structuredClone(this.config.workflows), custom_fields: structuredClone(this.config.custom_fields),
      statuses: Object.fromEntries(Object.entries(this.config.workflows).map(([kind, workflow]) => [kind, workflow!.states.map(state => state.id)])) };
  }
  source(id: string): FileRecord | UnsupportedFile {
    const record = this.projection.get(id);
    if (record) return record;
    const snapshot = this.snapshot();
    const unsupported = snapshot.unsupportedFiles.filter(file => file.id === id);
    if (unsupported.length > 1) throw new WorkspaceError(409, `Duplicate ID ${id}`, undefined, unsupported.flatMap(file => file.diagnostics));
    if (unsupported[0]) return unsupported[0];
    throw new WorkspaceError(404, `Entity not found: ${id}`);
  }
  get(id: string): FileRecord {
    const source = this.source(id);
    if (!('entity' in source)) throw new WorkspaceError(422, source.diagnostics.map(item => item.message).join('; '), undefined, source.diagnostics);
    return source;
  }
  rescan(reason = 'external'): Promise<void> { return this.serialize(() => this.scan(reason)); }

  private validateConfigurationFiles(configuration: ProtocolConfiguration, collected: RepositoryCollection): Diagnostic[] {
    const errors = collected.errors.map(item => diagnostic('FILE_UNREADABLE', item.message, item.path));
    const files: FileRecord[] = [];
    for (const file of collected.files) {
      try {
        const entity = parseMarkdown(file.raw, configuration);
        files.push({ ...file, id: entity.id, entity, revision: revisionOf(file.raw) });
      } catch (error) { errors.push(...diagnosticsOf(error, { path: file.path })); }
    }
    errors.push(...validateRelations(files, configuration).filter(item => item.severity === 'error'));
    for (const file of collected.views) {
      try {
        const document = parseDocument(file.raw, { uniqueKeys: true });
        if (document.errors.length) throw new Error(document.errors.map(error => error.message).join('; '));
        const view = validateView(document.toJS({ maxAliasCount: 50 }), configuration);
        this.validateOrder(view, files, file.path);
      } catch (error) {
        errors.push(...(error instanceof WorkspaceError ? error.diagnostics : diagnosticsOf(error, { path: file.path })));
      }
    }
    return errors;
  }

  private loadConfiguration(collected: RepositoryCollection, validateCompatibility = true): void {
    let raw: string | undefined;
    this.configErrors = [];
    try {
      try { raw = this.repository.read('.pm/config.yaml'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.configRevision = raw === undefined ? 'absent' : revisionOf(raw);
      if (this.configRevision === this.acceptedConfigRevision) return;
      let candidate = defaultConfiguration;
      if (raw !== undefined) {
        const document = parseDocument(raw, { uniqueKeys: true });
        if (document.errors.length) throw new Error(document.errors.map(error => error.message).join('; '));
        candidate = parseConfiguration(document.toJS({ maxAliasCount: 50 }));
      }
      // A cold rebuild has no prior configuration to compare: malformed sources are repairable source errors.
      const errors = validateCompatibility ? this.validateConfigurationFiles(candidate, collected) : [];
      if (errors.length) {
        this.configErrors = [diagnostic('CONFIGURATION_INVALID', 'Configuration is incompatible with workspace sources; writes are blocked', '.pm/config.yaml'), ...errors];
        return;
      }
      this.config = candidate;
      this.acceptedConfigRevision = this.configRevision;
    } catch (error) {
      if (raw === undefined) this.configRevision = 'unreadable';
      this.configErrors = [diagnostic('CONFIGURATION_INVALID', messageOf(error), '.pm/config.yaml'), ...diagnosticsOf(error, { path: '.pm/config.yaml' })];
    }
  }

  assertWritable(configuration = true): void {
    try { this.locations.assertSettled(); }
    catch { throw new WorkspaceError(409, 'Project storage initialization or transfer requires recovery', undefined, [diagnostic('PROJECT_STORAGE_PENDING', 'Project storage initialization or transfer requires recovery', '.pm/state/project-locations.json')]); }
    if (this.state.transaction) throw new WorkspaceError(409, 'An unresolved transaction requires safe recovery', undefined,
      [diagnostic('RECOVERY_CONFLICT', 'An unresolved transaction requires safe recovery', '.pm/state/state.json')]);
    if (this.state.migrationProjection) throw new WorkspaceError(409, 'Migration projection retirement requires recovery', undefined,
      [diagnostic('MIGRATION_PENDING', 'Migration projection retirement requires recovery', '.pm/state/state.json')]);
    try { this.migrations.assertWritable(); }
    catch (error) { throw new WorkspaceError(409, messageOf(error), undefined, diagnosticsOf(error)); }
    if (this.migrationErrors.length) throw new WorkspaceError(409, 'Migration recovery requires intervention', undefined, this.migrationErrors);
    if (configuration && this.configErrors.length) throw new WorkspaceError(422, 'Invalid workspace configuration blocks writes', undefined, this.configErrors);
  }

  private validateOrder(view: ViewConfig, files: FileRecord[], path = ''): void {
    const known = new Map(files.map(file => [file.id, file]));
    for (const id of view.order ?? []) {
      const file = known.get(id);
      if (!file || view.entity && file.entity.entity !== view.entity) throw new WorkspaceError(422, `Manual order contains an invalid entity: ${id}`, undefined,
        [diagnostic('VIEW_ORDER_INVALID', `Manual order contains an unknown entity or wrong entity kind: ${id}`, path, undefined, 'order', id)]);
    }
  }

  private scan(reason: string, migratedTransitions: readonly MigrationTransition[] = []): void {
    const previous = this.projection.snapshot();
    const oldByPath = new Map(previous.files.map(file => [file.path, file]));
    const oldById = new Map(previous.files.map(file => [file.id, file]));
    const retirement = this.state.migrationProjection;
    const retired = new Set<string>();
    for (const transition of retirement?.transitions ?? []) {
      const key = JSON.stringify([transition.path, transition.fromRevision, transition.toRevision]);
      retired.add(key);
      this.pendingMigrationAcknowledgments.set(key, transition);
    }
    for (const baseline of this.state.migrationBaselines()) {
      oldByPath.set(baseline.path, baseline);
      oldById.set(baseline.id, baseline);
    }
    const migrated = new Map<string, MigrationTransition[]>();
    for (const transition of migratedTransitions) {
      const key = JSON.stringify([transition.path, transition.fromRevision, transition.toRevision]);
      this.pendingMigrationAcknowledgments.set(key, transition);
      if (!retired.has(key)) {
        const entries = migrated.get(transition.path) ?? [];
        entries.push(transition);
        migrated.set(transition.path, entries);
      }
    }
    const collected = this.repository.collect();
    this.loadConfiguration(collected);
    try {
      this.migrations.assertWritable();
    } catch (error) { this.migrationErrors = diagnosticsOf(error); }
    const errors: Diagnostic[] = collected.errors.map(item => diagnostic('FILE_UNREADABLE', item.message, item.path));
    errors.push(...this.configErrors, ...this.migrationErrors);
    if (this.state.transaction) errors.push(diagnostic('RECOVERY_CONFLICT', 'An unresolved transaction requires safe recovery', '.pm/state/state.json'));
    const candidates: FileRecord[] = [];
    const unsupportedFiles: UnsupportedFile[] = [];
    const reservedIds = new Set<string>();
    const identities: Identity[] = [];
    const copy = this.state.transaction;
    const unpublished = new Set(copy?.kind === 'duplicate' ? copy.records.map(record => record.path) : []);
    for (const file of collected.files) {
      if (unpublished.has(file.path)) continue; // Never expose a partially written project copy as a completed project.
      const identity = inspectMarkdown(file.raw);
      const filenameId = /(?:^|\/)([A-Z][A-Z0-9]*-\d+)\.md$/i.exec(file.path)?.[1];
      if (filenameId) reservedIds.add(filenameId.toUpperCase());
      if (identity.id) reservedIds.add(identity.id);
      const observed = this.state.identity(file.path);
      const old = oldByPath.get(file.path) ?? (identity.id ? oldById.get(identity.id) : undefined);
      const revision = revisionOf(file.raw);
      try {
        if (identity.id && this.state.deleted(identity.id)) throw new WorkspaceError(422, 'Permanently deleted identity cannot be restored', undefined, [diagnostic('TOMBSTONED_ID', 'Permanently deleted identity cannot be restored', file.path, identity.id, 'id')]);
        const mountedProject = /^project-roots\/(PRJ-\d+)\//.exec(file.path)?.[1];
        const entity = parseMarkdown(file.raw, this.config);
        if (mountedProject && (entity.entity === 'project' ? entity.id !== mountedProject : entity.project !== mountedProject)) throw new WorkspaceError(422, 'File does not belong to its registered project');
        if (observed && (observed.id !== entity.id || observed.entity && observed.entity !== entity.entity)) throw new WorkspaceError(422, 'Entity identity is immutable at its observed path', undefined, [diagnostic('IMMUTABLE_FIELD', 'Entity identity is immutable at its observed path', file.path, observed.id, observed.id !== entity.id ? 'id' : 'entity')]);
        const authorizedMigration = old && migrated.get(file.path)?.some(transition => transition.fromRevision === old.revision && transition.toRevision === revision);
        if (old && !authorizedMigration) {
          const transitions = validateTransition(old.entity, entity, this.config).map(item => ({ ...item, path: file.path }));
          if (transitions.some(item => item.severity === 'error')) throw new WorkspaceError(422, 'External workflow transition is not allowed', old, transitions);
        }
        candidates.push({ ...file, id: entity.id, entity, revision });
        identities.push({ path: file.path, id: entity.id, entity: entity.entity });
      } catch (error) {
        const diagnostics = error instanceof WorkspaceError ? error.diagnostics : diagnosticsOf(error, { path: file.path, ...(identity.id ? { entityId: identity.id } : {}) });
        errors.push(...diagnostics);
        const future = identity.schema !== undefined && identity.schema !== 'pm/v1';
        const tombstone = diagnostics.some(item => item.code === 'TOMBSTONED_ID');
        if (old && !future && !tombstone) candidates.push({ ...old, ...file, revision, stale: true, error: diagnostics.map(item => item.message).join('; '), diagnostics });
        else unsupportedFiles.push({ ...file, ...identity, ...(observed && !future && !tombstone ? { id: observed.id } : {}), revision, readOnly: true, diagnostics });
        if (identity.id && /^[A-Z][A-Z0-9]*-\d+$/.test(identity.id) && !observed) identities.push({ path: file.path, id: identity.id });
      }
    }
    for (const error of errors.filter(item => item.code === 'FILE_UNREADABLE')) {
      for (const old of oldByPath.values()) {
        if ((old.path === error.path || old.path.startsWith(`${error.path}/`)) && !candidates.some(file => file.path === old.path)) {
          candidates.push({ ...old, stale: true, error: error.message, diagnostics: [error] });
        }
      }
    }
    try { if (!this.migrationErrors.length && !this.state.transaction) this.state.observe(reservedIds, identities); }
    catch (error) { throw new WorkspaceError(422, messageOf(error), undefined, [diagnostic('PERSISTENT_STATE_INVALID', messageOf(error), '.pm/state/state.json')]); }
    const relations = validateRelations(candidates, this.config);
    errors.push(...relations);
    this.candidates = candidates;
    this.candidateErrors = relations;
    const byId = new Map<string, FileRecord[]>();
    for (const candidate of candidates) byId.set(candidate.id, [...(byId.get(candidate.id) ?? []), candidate]);
    const files: FileRecord[] = [];
    for (const [id, group] of byId) {
      if (group.length > 1) {
        const old = oldById.get(id);
        for (const file of group) {
          const diagnostics = errors.filter(item => item.path === file.path);
          if (old?.path === file.path) files.push({ ...old, raw: file.raw, revision: file.revision, stale: true, error: diagnostics.map(item => item.message).join('; '), diagnostics });
          else unsupportedFiles.push({ id, path: file.path, raw: file.raw, revision: file.revision, schema: file.entity.schema, readOnly: true, diagnostics });
        }
        continue;
      }
      const candidate = group[0]!;
      const diagnostics = errors.filter(item => item.path === candidate.path);
      const invalid = diagnostics.some(item => item.severity === 'error');
      const old = oldByPath.get(candidate.path) ?? oldById.get(id);
      files.push({ ...candidate, ...(invalid && old ? { entity: old.entity } : {}), ...(invalid ? { stale: true, error: diagnostics.filter(item => item.severity === 'error').map(item => item.message).join('; ') } : {}), ...(diagnostics.length ? { diagnostics } : {}) });
    }
    const views: SavedView[] = [];
    const viewIds = new Set<string>();
    for (const file of collected.views) {
      try {
        const document = parseDocument(file.raw, { uniqueKeys: true });
        if (document.errors.length) throw new Error(document.errors.map(error => error.message).join('; '));
        const value: unknown = document.toJS({ maxAliasCount: 50 });
        if (!plainObject(value)) throw new Error('Saved view must be a YAML mapping');
        const id = file.path.split('/').pop()!.replace(/\.ya?ml$/i, '');
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error('Invalid saved-view filename');
        if (value.id !== undefined && value.id !== id) throw new Error('Saved-view ID must match its filename');
        if (typeof value.name !== 'string' || !value.name.trim()) throw new Error('Saved view needs a name');
        if (viewIds.has(id)) throw new Error(`Duplicate saved-view ID: ${id}`);
        if (value.revision !== undefined) throw new Error('Saved-view revisions are system metadata and cannot be persisted');
        const view = validateView(value as unknown as ViewConfig, this.config);
        this.validateOrder(view, files, file.path);
        views.push({ ...view, id, name: value.name.trim(), revision: revisionOf(file.raw) });
        viewIds.add(id);
      } catch (error) { errors.push(...(error instanceof WorkspaceError ? error.diagnostics : diagnosticsOf(error, { path: file.path }))); }
    }
    files.sort((a, b) => a.id.localeCompare(b.id));
    this.history.observe(files, this.config, reason, !errors.some(issue => issue.severity === 'error'));
    this.factHistory.observe(files, reason, !errors.some(issue => issue.severity === 'error'));
    const historyError = this.history.failure();
    if (historyError) errors.push(diagnostic('SPRINT_HISTORY_UNAVAILABLE', historyError, '.pm/state/sprint-history'));
    errors.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
    views.sort((a, b) => a.id.localeCompare(b.id));
    const projected = new Map(files.map(file => [file.path, file]));
    const retiring = !this.migrationErrors.length && !this.configErrors.length
      ? [...this.pendingMigrationAcknowledgments.values()].filter(transition => {
        if (transition.path === '.pm/config.yaml') return true;
        const current = projected.get(transition.path) ?? files.find(file => file.id === this.state.identity(transition.path)?.id);
        return !!current && !current.stale;
      }) : [];
    // The accepted comparison baseline and retirement decision must be durable before cache publication.
    if (retiring.length || this.state.migrationProjection) {
      try { this.state.stageMigrationProjection(retiring, files, this.config, this.acceptedConfigRevision); }
      catch (error) { throw new WorkspaceError(422, messageOf(error), undefined, [diagnostic('PERSISTENT_STATE_INVALID', messageOf(error), '.pm/state/state.json')]); }
    }
    const fingerprint = revisionOf(JSON.stringify({ files, errors, views, unsupportedFiles, configuration: this.config, configurationRevision: this.configRevision, configurationErrors: this.configErrors }));
    if (fingerprint !== this.fingerprint) {
      this.projection.replace(files, errors, views, unsupportedFiles, this.config, this.configRevision, this.configErrors);
      this.fingerprint = fingerprint;
      this.notify({ type: 'change', reason, errors });
    }
    const journal = this.state.migrationProjection;
    if (journal && !this.migrationErrors.length) {
      try {
        this.migrations.acknowledgeTransitions(journal.transitions);
        this.state.finishMigrationProjection();
        for (const transition of journal.transitions) this.pendingMigrationAcknowledgments.delete(JSON.stringify([transition.path, transition.fromRevision, transition.toRevision]));
      } catch (error) {
        this.migrationErrors = diagnosticsOf(error);
        this.scan('migration-acknowledgment-error');
      }
    }
  }

  private writable(id: string, revision: string, allowRepair = false): FileRecord | UnsupportedFile {
    if (typeof revision !== 'string' || !revision) throw new WorkspaceError(400, 'A revision is required');
    this.scan('refresh');
    this.assertWritable();
    const current = this.source(id);
    const diagnostics = current.diagnostics ?? [];
    if (diagnostics.some(item => item.code === 'DUPLICATE_ID' || item.code === 'FILE_UNREADABLE')) {
      throw new WorkspaceError(409, 'Source is ambiguous or unsafe to write', 'entity' in current ? current : undefined, diagnostics);
    }
    if ((!('entity' in current) && current.schema !== undefined && current.schema !== 'pm/v1') || diagnostics.some(item => item.code === 'UNSUPPORTED_SCHEMA_VERSION' || item.code === 'TOMBSTONED_ID')) {
      throw new WorkspaceError(422, diagnostics.map(item => item.message).join('; ') || 'Source is read only', 'entity' in current ? current : undefined, diagnostics);
    }
    if (current.revision !== revision) throw new WorkspaceError(409, 'Revision conflict: the file changed on disk', 'entity' in current ? current : undefined, [diagnostic('REVISION_CONFLICT', 'Revision conflict: the file changed on disk', current.path, id)]);
    if (!allowRepair && (!('entity' in current) || current.stale)) throw new WorkspaceError(409, 'File is not synchronized; repair its raw Markdown first', 'entity' in current ? current : undefined, diagnostics);
    return current;
  }

  private validateCandidate(candidate: FileRecord): void {
    const files = [...this.candidates.filter(file => file.path !== candidate.path), candidate];
    const previous = new Set(this.candidateErrors.filter(item => item.severity === 'error').map(diagnosticKey));
    const errors = validateRelations(files, this.config).filter(item => item.severity === 'error' && (item.path === candidate.path || !previous.has(diagnosticKey(item))));
    if (errors.length) throw new WorkspaceError(422, errors.map(item => item.message).join('; '), this.projection.get(candidate.id), errors);
  }

  private publishSavedMutation(before: FileRecord | undefined, after: FileRecord | undefined, capture: WorkspaceMutationCapture | undefined): void {
    try {
      if (capture) this.factHistory.accept(before, after, capture.committed(before, after));
      this.scan('command');
    } catch (error) {
      throw new WorkspaceError(422, 'The file was saved but durable fact publication requires recovery', after ?? before,
        [diagnostic('PERSISTENT_STATE_INVALID', messageOf(error), '.pm/state/service-observations.json', after?.id ?? before?.id)]);
    }
  }

  private async commit(current: FileRecord | UnsupportedFile, raw: string, guard?: WorkspaceMutationGuard): Promise<FileRecord> {
    let entity;
    try { entity = parseMarkdown(raw, this.config); }
    catch (error) { throw new WorkspaceError(422, messageOf(error), 'entity' in current ? current : undefined, diagnosticsOf(error, { path: current.path, ...(current.id ? { entityId: current.id } : {}) })); }
    const observed = this.state.identity(current.path);
    const originalKind = 'entity' in current ? current.entity.entity : observed?.entity;
    if (entity.id !== current.id || originalKind && entity.entity !== originalKind) throw new WorkspaceError(422, 'Entity identity is immutable', undefined, [diagnostic('IMMUTABLE_FIELD', 'Entity identity is immutable', current.path, current.id, entity.id !== current.id ? 'id' : 'entity')]);
    if ('entity' in current) {
      const transitions = validateTransition(current.entity, entity, this.config).map(item => ({ ...item, path: current.path }));
      if (transitions.some(item => item.severity === 'error')) throw new WorkspaceError(422, 'Workflow transition is not allowed', current, transitions);
    }
    if (Buffer.byteLength(raw, 'utf8') > maxRepositoryFileBytes) throw new WorkspaceError(422, 'Markdown exceeds the 4 MiB limit');
    this.validateCandidate({ id: entity.id, path: current.path, raw, revision: revisionOf(raw), entity });
    await guard?.('entity' in current ? current : undefined, entity);
    const candidate: FileRecord = { id: entity.id, path: current.path, raw, revision: revisionOf(raw), entity };
    const before = 'entity' in current ? current : undefined;
    const capture = this.mutationCapture.getStore();
    await capture?.prepare(before, candidate);
    try { this.repository.write(current.path, raw, current.revision); }
    catch (error) {
      this.scan('conflict');
      throw new WorkspaceError(error instanceof RepositoryConflict ? 409 : 422, messageOf(error), this.projection.get(entity.id), [diagnostic(error instanceof RepositoryConflict ? 'REVISION_CONFLICT' : 'FILE_UNWRITABLE', messageOf(error), current.path, entity.id)]);
    }
    this.publishSavedMutation(before, candidate, capture);
    return this.get(entity.id);
  }

  save(id: string, raw: string, revision: string, guard?: WorkspaceMutationGuard): Promise<FileRecord> {
    return this.serialize(() => {
      if (typeof raw !== 'string') throw new WorkspaceError(400, 'raw must be a string');
      return this.commit(this.writable(id, revision, true), raw, guard);
    });
  }
  patch(id: string, changes: Record<string, unknown>, revision: string, guard?: WorkspaceMutationGuard): Promise<FileRecord> {
    return this.serialize(() => {
      if (!plainObject(changes)) throw new WorkspaceError(400, 'changes must be an object');
      const current = this.writable(id, revision);
      let raw;
      try { raw = patchMarkdown(current.raw, changes, this.config); }
      catch (error) { throw new WorkspaceError(422, messageOf(error), 'entity' in current ? current : undefined, diagnosticsOf(error, { path: current.path, entityId: id })); }
      return this.commit(current, raw, guard);
    });
  }
  archive(id: string, revision: string, guard?: WorkspaceMutationGuard): Promise<FileRecord> { return this.patch(id, { archived: true }, revision, guard); }
  restore(id: string, revision: string, guard?: WorkspaceMutationGuard): Promise<FileRecord> { return this.patch(id, { archived: false }, revision, guard); }
  create(input: Record<string, unknown>, idempotencyKey?: string, guard?: WorkspaceMutationGuard, prepared?: WorkspaceCreationPrepared): Promise<FileRecord> {
    if (!plainObject(input) || 'entity' in input) return Promise.reject(new WorkspaceError(400, 'POST items creates work items; use entity creation for explicit entity types'));
    return this.createEntity({ ...input, entity: 'work_item' }, idempotencyKey, guard, prepared);
  }
  createEntity(input: Record<string, unknown>, idempotencyKey?: string, guard?: WorkspaceMutationGuard, prepared?: WorkspaceCreationPrepared): Promise<FileRecord> {
    return this.serialize(async () => {
      if (!plainObject(input) || typeof input.title !== 'string' || !input.title.trim()) throw new WorkspaceError(400, 'A title is required');
      if ('id' in input || 'schema' in input) throw new WorkspaceError(400, 'Identity is allocated by the server', undefined, [diagnostic('IMMUTABLE_FIELD', 'Identity is allocated by the server', '', undefined, 'id' in input ? 'id' : 'schema')]);
      if (typeof input.entity !== 'string' || !entityKinds.includes(input.entity as EntityKind)) throw new WorkspaceError(400, `entity must be one of ${entityKinds.join(', ')}`);
      const entity = input.entity as EntityKind;
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 512)) throw new WorkspaceError(400, 'Idempotency-Key must be a nonempty string of at most 512 characters');
      this.scan('refresh');
      this.assertWritable();
      let hash: string;
      try { hash = requestHash(input); }
      catch (error) { throw new WorkspaceError(400, messageOf(error)); }
      const previous = idempotencyKey ? this.state.request(idempotencyKey) : undefined;
      if (previous) {
        if (previous.hash !== hash || this.state.deleted(previous.id)) throw new WorkspaceError(409, 'Idempotency key conflicts with its original creation', undefined, [diagnostic('IDEMPOTENCY_CONFLICT', 'Idempotency key conflicts with its original creation', '', previous.id)]);
        const existing = this.projection.get(previous.id);
        if (!existing || existing.stale) throw new WorkspaceError(409, 'The idempotent creation no longer has a valid source; it cannot be recreated', existing, [diagnostic('IDEMPOTENCY_CONFLICT', 'The idempotent creation no longer has a valid source; it cannot be recreated', existing?.path ?? '', previous.id)]);
        return existing;
      }
      const { prefix, directory: entityDirectory } = entityDefinitions[entity];
      let mount: ProjectMount | null;
      try { mount = typeof input.project === 'string' ? this.locations.get(input.project) : null; }
      catch { throw new WorkspaceError(409, 'Registered project storage is unavailable', undefined, [diagnostic('PROJECT_STORAGE_UNAVAILABLE', 'Registered project storage is unavailable', `project-roots/${String(input.project)}`)]); }
      const directory = mount ? `${mount.virtualPrefix}/${entityDirectory}` : entityDirectory;
      let next = 1;
      for (const id of this.state.ids) {
        const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
        if (match) next = Math.max(next, Number(match[1]) + 1);
      }
      if (!Number.isSafeInteger(next)) throw new WorkspaceError(422, 'Identifier range is exhausted');
      const id = `${prefix}-${String(next).padStart(3, '0')}`;
      let raw: string;
      try { raw = createMarkdown({ ...input, id, title: input.title }, this.config); }
      catch (error) { throw new WorkspaceError(422, messageOf(error), undefined, diagnosticsOf(error, { entityId: id })); }
      if (Buffer.byteLength(raw, 'utf8') > maxRepositoryFileBytes) throw new WorkspaceError(422, 'Markdown exceeds the 4 MiB limit');
      const path = `${directory}/${id}.md`;
      const candidate = { id, path, raw, revision: revisionOf(raw), entity: parseMarkdown(raw, this.config) };
      this.validateCandidate(candidate);
      await guard?.(undefined, candidate.entity);
      prepared?.(candidate);
      const capture = this.mutationCapture.getStore();
      await capture?.prepare(undefined, candidate);
      try {
        this.repository.mkdir(directory);
        this.state.begin({ kind: 'create', id, path, raw, ...(idempotencyKey ? { idempotency: { key: idempotencyKey, hash, id } } : {}) });
        this.repository.write(path, raw);
        this.state.finish();
      } catch (error) { throw new WorkspaceError(error instanceof RepositoryConflict ? 409 : 422, messageOf(error), undefined, [diagnostic('TRANSACTION_FAILED', messageOf(error), path, id)]); }
      this.publishSavedMutation(undefined, candidate, capture);
      return this.get(id);
    });
  }

  /** Frozen multi-file business operation; every ID is reserved before touching a destination. */
  duplicateProject(sourceId: string, revision: string, input: ProjectCopyInput, key: string, directory?: ProjectDirectory, guard?: WorkspaceMutationGuard, prepared?: (records: readonly FileRecord[]) => void): Promise<ProjectCopyResult> {
    return this.serialize(async () => {
      if (!key.trim() || key.length > 512 || !input.name.trim() || input.name.length > 300 || typeof input.includeTasks !== 'boolean') throw new WorkspaceError(400, 'A name, includeTasks and original command key are required');
      const hash = requestHash({ sourceId, revision, input, directory: directory ?? null });
      const previous = this.state.request(key);
      let pending = this.state.transaction;
      if (previous) {
        if (previous.hash !== hash || !previous.copy || this.state.deleted(previous.id)) throw new WorkspaceError(409, 'Copy key conflicts with its original request');
        this.scan('copy-reconcile');
        for (const record of previous.copy.records) {
          const current = this.get(record.id);
          if (current.stale || this.state.deleted(record.id)) throw new WorkspaceError(409, 'The copied destination is no longer safely readable', current);
        }
        return { id: previous.id, projectId: previous.id, sourceProjectId: previous.copy.sourceProjectId,
          taskIdMap: { ...previous.copy.taskIdMap }, copiedTaskCount: previous.copy.copiedTaskCount };
      }
      if (pending && (pending.kind !== 'duplicate' || pending.idempotency.key !== key || pending.idempotency.hash !== hash)) throw new WorkspaceError(409, 'Another durable transaction requires recovery');
      if (this.configErrors.length || this.migrationErrors.length || this.state.migrationProjection) throw new WorkspaceError(409, 'Workspace configuration requires recovery');
      let records: FileRecord[];
      if (!pending) {
        const source = this.writable(sourceId, revision);
        if (!('entity' in source) || source.entity.entity !== 'project') throw new WorkspaceError(400, 'A valid source project is required');
        const tasks = input.includeTasks ? this.snapshot().files.filter(file => file.entity.entity === 'work_item' && file.entity.project === sourceId && file.entity.archived !== true).sort((a, b) => a.id.localeCompare(b.id)) : [];
        const ids = new Map<string, string>();
        const nextByPrefix = new Map<string, number>();
        for (const id of this.state.ids) {
          const match = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(id);
          if (match) nextByPrefix.set(match[1]!, Math.max(nextByPrefix.get(match[1]!) ?? 1, Number(match[2]) + 1));
        }
        for (const record of [source, ...tasks]) {
          const prefix = entityDefinitions[record.entity.entity].prefix;
          const next = nextByPrefix.get(prefix) ?? 1;
          if (!Number.isSafeInteger(next)) throw new WorkspaceError(422, 'Identifier range is exhausted');
          ids.set(record.id, `${prefix}-${String(next).padStart(3, '0')}`);
          nextByPrefix.set(prefix, next + 1);
        }
        records = projectCopyRecords(this.snapshot().files, source, tasks, ids, input, this.config, !!directory);
        if (records.some(record => Buffer.byteLength(record.raw, 'utf8') > maxRepositoryFileBytes)) throw new WorkspaceError(422, 'Copied Markdown exceeds the 4 MiB limit');
        const errors = validateRelations([...this.snapshot().files, ...records], this.config).filter(issue => issue.severity === 'error');
        if (errors.length) throw new WorkspaceError(422, 'Copied relationships are invalid', undefined, errors);
        for (const record of records) await guard?.(undefined, record.entity, records);
        const check = directory ? this.locations.preview(directory) : undefined;
        const project = records[0]!;
        const taskIdMap = Object.fromEntries(tasks.map(task => [task.id, ids.get(task.id)!]));
        for (const original of [source, ...tasks]) if (this.repository.read(original.path) !== original.raw) throw new WorkspaceError(409, 'Source changed while preparing the project copy', original);
        this.state.begin({ kind: 'duplicate', id: project.id, path: project.path, raw: project.raw,
          records: records.map(({ id, path, raw }) => ({ id, path, raw })),
          idempotency: { key, hash, id: project.id, copy: { sourceProjectId: sourceId, sourceRevision: revision, taskIdMap, copiedTaskCount: tasks.length,
            records: records.map(({ id, revision }) => ({ id, revision })) } },
          ...(directory && check ? { projectDirectory: { workspaceId: directory.workspaceId, hash, check } } : {}) });
        pending = this.state.transaction;
      } else {
        if (pending.kind !== 'duplicate') throw new WorkspaceError(409, 'Another operation requires recovery');
        records = pending.records.map(record => ({ ...record, revision: revisionOf(record.raw), entity: parseMarkdown(record.raw, this.config) }));
        for (const record of records) await guard?.(undefined, record.entity, records);
      }
      if (pending?.kind !== 'duplicate') throw new WorkspaceError(409, 'Copy reservation is unavailable');
      const result: ProjectCopyResult = { id: pending.id, projectId: pending.id, sourceProjectId: pending.idempotency.copy.sourceProjectId,
        taskIdMap: { ...pending.idempotency.copy.taskIdMap }, copiedTaskCount: pending.idempotency.copy.copiedTaskCount };
      prepared?.(records);
      const capture = this.mutationCapture.getStore();
      for (const record of records) await capture?.prepare(undefined, record);
      try {
        if (directory) {
          this.locations.reserve(pending.id, key, hash, directory, pending.projectDirectory?.check);
          this.locations.prepare(pending.id);
        }
        // Leave the transaction present until both the manifest and local registration are durable.
        this.state.writeDuplicate(this.config);
        if (directory) { this.locations.contentWritten(pending.id); this.locations.finish(pending.id); }
        this.state.finish();
        await this.refreshProjectWatches();
        for (const record of records) if (capture) this.factHistory.accept(undefined, record, capture.committed(undefined, record));
        this.scan('project-copy');
      } catch (error) {
        throw new WorkspaceError(409, 'The original project copy requires explicit recovery', undefined,
          [diagnostic('PROJECT_COPY_PENDING', messageOf(error), pending.path, pending.id)]);
      }
      return result;
    });
  }

  projectCopyReservation(key: string): { sourceRevision: string } | undefined {
    const request = this.state.request(key);
    if (request?.copy) return { sourceRevision: request.copy.sourceRevision };
    const pending = this.state.transaction;
    return pending?.kind === 'duplicate' && pending.idempotency.key === key ? { sourceRevision: pending.idempotency.copy.sourceRevision } : undefined;
  }

  projectLocation(projectId: string): ProjectMount | null { return this.locations.get(projectId); }
  projectLocations(): ProjectLocation[] { return this.locations.list(); }
  private async refreshProjectWatches(): Promise<void> {
    if (!this.watcher) return;
    const next = this.locations.watchPaths();
    if (next.length === this.watchedProjectPaths.length && next.every(item => this.watchedProjectPaths.includes(item))) return;
    const previous = this.watcher;
    this.watcher = await this.watchSources(next);
    await previous.close();
    this.watchedProjectPaths = next;
  }

  private async watchSources(projectPaths: string[]): Promise<FSWatcher> {
    const watcher = chokidar.watch([this.root, ...projectPaths], {
      ignoreInitial: true, followSymlinks: false,
      ignored: filename => filename.includes('/.pm/cache') || filename.includes('/.pm/state') || filename.split('/').some(part => part.startsWith('.pm-write-')),
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
    });
    watcher.on('all', () => {
      if (this.closed) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { void this.rescan('external').catch(error => this.notify({ type: 'error', reason: 'watcher', message: messageOf(error), errors: error instanceof WorkspaceError ? error.diagnostics : diagnosticsOf(error) })); }, 60);
    });
    watcher.on('error', error => this.notify({ type: 'error', reason: 'watcher', message: 'Workspace source watcher failed', errors: diagnosticsOf(error).map(issue => ({ ...issue, message: 'Workspace source watcher failed' })) }));
    try {
      await new Promise<void>((ready, failed) => { watcher.once('ready', ready); watcher.once('error', failed); });
      return watcher;
    } catch (error) { await watcher.close(); throw error; }
  }

  /** Original native creation key, shared durable ID reservation, and resumable physical initialization. */
  initializeProject(input: Record<string, unknown>, key: string, directory: ProjectDirectory, guard?: WorkspaceMutationGuard, prepared?: WorkspaceCreationPrepared): Promise<FileRecord> {
    return this.serialize(async () => {
      if (!plainObject(input) || input.entity !== 'project' || typeof input.title !== 'string' || !input.title.trim() || 'id' in input || 'schema' in input) throw new WorkspaceError(400, 'Project initialization requires a project title and server-allocated identity');
      if (typeof key !== 'string' || !key.trim() || key.length > 512) throw new WorkspaceError(400, 'A stable original creation key is required');
      const hash = requestHash(input), locationHash = requestHash({ input, directory });
      const previous = this.state.request(key), pending = this.state.transaction;
      const reserved = this.locations.list().find(entry => entry.initialization.key === key);
      if (previous && (previous.hash !== hash || this.state.deleted(previous.id))) throw new WorkspaceError(409, 'Idempotency key conflicts with its original creation');
      if (previous && !reserved) throw new WorkspaceError(409, 'The original creation did not reserve this local project directory');
      if (pending && (pending.kind !== 'create' || pending.idempotency?.key !== key || pending.idempotency.hash !== hash || pending.path !== `project-roots/${pending.id}/projects/${pending.id}.md`)) throw new WorkspaceError(409, 'Another durable transaction requires recovery');
      if (pending?.kind === 'create' && pending.projectDirectory && (pending.projectDirectory.hash !== locationHash || pending.projectDirectory.workspaceId !== directory.workspaceId || pending.projectDirectory.check.root !== directory.root || pending.projectDirectory.check.mode !== (directory.mode ?? 'existing'))) throw new WorkspaceError(409, 'Project directory conflicts with the original durable reservation');
      if (this.configErrors.length || this.migrationErrors.length || this.state.migrationProjection) throw new WorkspaceError(409, 'Workspace configuration or migration requires recovery');
      if (reserved && reserved.initialization.hash !== locationHash) throw new WorkspaceError(409, 'Project initialization conflicts with its original directory or input');
      if (previous && reserved?.status === 'ready') {
        try { this.locations.get(previous.id); }
        catch { throw new WorkspaceError(409, 'The original project directory is unavailable or its identity has changed'); }
        this.scan('refresh');
        const existing = this.get(previous.id);
        if (existing.stale) throw new WorkspaceError(409, 'The original project source requires recovery', existing);
        return existing;
      }
      let directoryCheck: ProjectDirectoryCheck | undefined = pending?.kind === 'create' ? pending.projectDirectory?.check : undefined;
      if (!pending && !previous && !reserved) {
        this.scan('refresh');
        this.assertWritable();
        directoryCheck = this.locations.preview(directory);
      }
      let id = previous?.id ?? pending?.id ?? reserved?.projectId;
      if (!id) {
        let next = 1;
        for (const known of this.state.ids) { const match = /^PRJ-(\d+)$/.exec(known); if (match) next = Math.max(next, Number(match[1]) + 1); }
        if (!Number.isSafeInteger(next)) throw new WorkspaceError(422, 'Identifier range is exhausted');
        id = `PRJ-${String(next).padStart(3, '0')}`;
      }
      const relative = `project-roots/${id}/projects/${id}.md`;
      let raw: string;
      try { raw = pending?.kind === 'create' ? pending.raw : createMarkdown({ ...input, id, title: input.title }, this.config); }
      catch (error) { throw new WorkspaceError(422, messageOf(error), undefined, diagnosticsOf(error, { entityId: id })); }
      if (Buffer.byteLength(raw, 'utf8') > maxRepositoryFileBytes) throw new WorkspaceError(422, 'Markdown exceeds the 4 MiB limit');
      const candidate: FileRecord = { id, path: relative, raw, revision: revisionOf(raw), entity: parseMarkdown(raw, this.config) };
      this.validateCandidate(candidate);
      await guard?.(undefined, candidate.entity);
      prepared?.(candidate);
      const capture = this.mutationCapture.getStore();
      await capture?.prepare(undefined, candidate);
      try {
        // The shared journal reserves ID + original key before the selected directory is touched.
        if (!pending && !previous) this.state.begin({ kind: 'create', id, path: relative, raw, idempotency: { key, hash, id }, ...(directoryCheck ? { projectDirectory: { workspaceId: directory.workspaceId, hash: locationHash, check: directoryCheck } } : {}) });
        this.locations.reserve(id, key, locationHash, directory, directoryCheck);
        this.locations.prepare(id);
        let current: string | undefined;
        try { current = this.repository.read(relative); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (current === undefined) this.repository.write(relative, raw);
        else if (current !== raw) throw new RepositoryConflict('Initialized project bytes conflict with the original request');
        this.locations.contentWritten(id);
        if (this.repository.read(relative) !== (current ?? raw)) throw new RepositoryConflict('Project changed during initialization');
        this.state.finish();
        this.locations.finish(id);
        await this.refreshProjectWatches();
      } catch (error) { throw new WorkspaceError(error instanceof RepositoryConflict ? 409 : 422, 'Project initialization requires recovery', undefined, [diagnostic('PROJECT_INITIALIZATION_PENDING', messageOf(error).replaceAll(directory.root, '[project directory]'), relative, id)]); }
      this.publishSavedMutation(undefined, candidate, capture);
      const result = this.get(id);
      if (result.stale || result.revision !== revisionOf(this.repository.read(relative))) throw new WorkspaceError(409, 'Project final disk verification failed', result);
      return result;
    });
  }

  migrateProject(projectId: string, key: string, directory: ProjectDirectory): Promise<ProjectMount> {
    return this.transferProject(projectId, key, directory, false);
  }
  relocateProject(projectId: string, key: string, directory: ProjectDirectory): Promise<ProjectMount> {
    return this.transferProject(projectId, key, directory, true);
  }
  rebindProject(projectId: string, key: string, directory: ProjectDirectory): Promise<ProjectMount> {
    return this.serialize(async () => {
      if (typeof key !== 'string' || !key.trim() || key.length > 512) throw new WorkspaceError(400, 'A stable rebind key is required');
      this.assertWritable();
      try {
        const result = this.locations.rebindMoved(projectId, key, directory, sources => {
          const previous = this.snapshot().files.filter(file => file.id === projectId || file.entity.project === projectId);
          const files: FileRecord[] = sources.map(file => {
            const entity = parseMarkdown(file.raw, this.config), known = this.state.identity(file.path);
            if (this.state.deleted(entity.id) || known && (known.id !== entity.id || known.entity && known.entity !== entity.entity)) throw new Error('Moved project source conflicts with registered identity');
            return { ...file, entity, id: entity.id, revision: revisionOf(file.raw) };
          });
          if (previous.some(file => !files.some(current => current.id === file.id && current.revision === file.revision))) throw new Error('Moved project differs from its last verified authority');
          const aggregate = [...this.snapshot().files.filter(file => file.id !== projectId && file.entity.project !== projectId), ...files];
          if (new Set(aggregate.map(file => file.id)).size !== aggregate.length || validateRelations(aggregate, this.config).some(issue => issue.severity === 'error')) throw new Error('Moved project relationships are invalid');
        });
        await this.refreshProjectWatches();
        this.scan('project-storage-rebind');
        return result;
      } catch { throw new WorkspaceError(409, 'Moved project directory failed identity or content verification'); }
    });
  }
  private transferProject(projectId: string, key: string, directory: ProjectDirectory, relocate: boolean): Promise<ProjectMount> {
    return this.serialize(async () => {
      if (typeof key !== 'string' || !key.trim() || key.length > 512) throw new WorkspaceError(400, 'A stable transfer key is required');
      const resuming = this.locations.entry(projectId)?.status === 'moving';
      if (!resuming) {
        this.scan('refresh'); this.assertWritable();
        const project = this.get(projectId);
        if (project.entity.entity !== 'project' || project.stale) throw new WorkspaceError(409, 'Project source is not safely transferable', project);
      }
      const sources = this.snapshot().files.filter(file => file.id === projectId || file.entity.project === projectId);
      if (!resuming && (sources.some(file => file.stale) || this.snapshot().errors.some(issue => issue.severity === 'error'))) throw new WorkspaceError(409, 'Workspace contains an invalid or unreadable source');
      try {
        const result = this.locations.transfer(projectId, key, directory, sources, relocate);
        await this.refreshProjectWatches();
        this.scan('project-storage-transfer');
        return result;
      } catch (error) { throw new WorkspaceError(409, 'Project storage transfer requires recovery', undefined, [diagnostic('PROJECT_TRANSFER_PENDING', messageOf(error).replaceAll(directory.root, '[project directory]'), `project-roots/${projectId}`, projectId)]); }
    });
  }

  delete(id: string, revision: string): Promise<{ id: string; deleted: true }> {
    return this.serialize(async () => {
      const current = this.writable(id, revision);
      if (!('entity' in current) || !current.entity.archived) throw new WorkspaceError(422, 'Archive the entity before permanent deletion', 'entity' in current ? current : undefined, [diagnostic('DELETE_REQUIRES_ARCHIVE', 'Archive the entity before permanent deletion', current.path, id, 'archived')]);
      const snapshot = this.snapshot();
      const diagnostics: Diagnostic[] = [];
      const resolver = createReferenceResolver(snapshot.files);
      for (const file of snapshot.unsupportedFiles) diagnostics.push(diagnostic('DELETE_UNVERIFIABLE', 'Cannot prove reference safety while this source is invalid or unsupported', file.path, file.id, undefined, id));
      const viewById = new Map(snapshot.views.map(view => [view.id, view]));
      for (const source of this.repository.collect().views) {
        const view = viewById.get(source.path.replace(/^.*\//, '').replace(/\.ya?ml$/i, ''));
        if (view?.order?.includes(id)) diagnostics.push(diagnostic('DELETE_REFERENCED',
          `Saved view ${view.name} (${view.id}) explicitly orders ${id}`, source.path, undefined, 'order', id));
      }
      for (const file of snapshot.files) {
        if (file.id === id) continue;
        if (file.stale) diagnostics.push(diagnostic('DELETE_UNVERIFIABLE', 'Cannot prove reference safety while this source is invalid', file.path, file.id, undefined, id));
        for (const { field, targetId } of referenceEntries(file.entity, this.config)) {
          if (targetId === id) diagnostics.push(diagnostic('DELETE_REFERENCED', `Entity is referenced by ${file.id}.${field}`, file.path, file.id, field, id));
        }
        for (const target of file.entity.links) if (resolver.resolve(target).file?.id === id) diagnostics.push(diagnostic('DELETE_REFERENCED', `Entity is linked from ${file.id}`, file.path, file.id, 'links', id));
        for (const [index, view] of file.entity.views.entries()) {
          if (view.order?.includes(id)) diagnostics.push(diagnostic('DELETE_REFERENCED',
            `Embedded view ${index + 1} in ${file.id} explicitly orders ${id}`, file.path, file.id, `views.${index}.order`, id));
        }
      }
      for (const error of snapshot.errors) {
        if (error.code === 'FILE_UNREADABLE' || error.path.startsWith('.pm/views/') && error.severity === 'error')
          diagnostics.push(diagnostic('DELETE_UNVERIFIABLE', error.message, error.path, undefined, undefined, id));
      }
      if (diagnostics.length) throw new WorkspaceError(422, 'Permanent deletion is blocked by inbound references or unreadable sources', current, diagnostics);
      const capture = this.mutationCapture.getStore();
      await capture?.prepare(current, undefined);
      try {
        this.state.begin({ kind: 'delete', id, path: current.path, raw: current.raw });
        this.repository.remove(current.path, current.revision);
        this.state.finish();
      } catch (error) { throw new WorkspaceError(error instanceof RepositoryConflict ? 409 : 422, messageOf(error), current, [diagnostic('TRANSACTION_FAILED', messageOf(error), current.path, id)]); }
      this.publishSavedMutation(current, undefined, capture);
      return { id, deleted: true };
    });
  }

  saveView(id: string, input: Record<string, unknown>): Promise<SavedView> {
    return this.serialize(() => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new WorkspaceError(400, 'Invalid view ID');
      if (!plainObject(input) || typeof input.name !== 'string' || !input.name.trim()) throw new WorkspaceError(400, 'A view name is required');
      if (input.id !== undefined && input.id !== id) throw new WorkspaceError(400, 'Saved-view ID must match its filename');
      this.scan('refresh');
      this.assertWritable();
      const collected = this.repository.collect();
      const unsafe = collected.errors.filter(file => file.path.startsWith('.pm/views/') && file.path.replace(/^.*\//, '').replace(/\.ya?ml$/i, '') === id);
      if (unsafe.length) throw new WorkspaceError(422, 'Saved-view source is unreadable', undefined, unsafe.map(file => diagnostic('FILE_UNREADABLE', file.message, file.path)));
      const matches = collected.views.filter(file => file.path.replace(/^.*\//, '').replace(/\.ya?ml$/i, '') === id);
      if (matches.length > 1) throw new WorkspaceError(409, 'Saved-view identity is ambiguous');
      const relative = matches[0]?.path ?? `.pm/views/${id}.yaml`;
      const revision = matches[0] ? revisionOf(matches[0].raw) : undefined;
      if (input.revision !== revision) throw new WorkspaceError(409, 'Saved-view revision conflict', undefined,
        [diagnostic('REVISION_CONFLICT', revision === undefined ? 'A new view must not supply a revision' : 'Supply the current saved-view revision', relative)]);
      let view: SavedView;
      try {
        const { revision: _revision, ...value } = input;
        view = { ...validateView(value as unknown as ViewConfig, this.config), id, name: input.name.trim() };
        this.validateOrder(view, this.snapshot().files, relative);
      } catch (error) { throw new WorkspaceError(422, messageOf(error), undefined, error instanceof WorkspaceError ? error.diagnostics : diagnosticsOf(error, { path: relative })); }
      const raw = stringify(view);
      if (Buffer.byteLength(raw, 'utf8') > maxRepositoryFileBytes) throw new WorkspaceError(422, 'Saved view exceeds the 4 MiB limit');
      try { this.repository.write(relative, raw, revision); }
      catch (error) { throw new WorkspaceError(error instanceof RepositoryConflict ? 409 : 422, messageOf(error), undefined, [diagnostic(error instanceof RepositoryConflict ? 'REVISION_CONFLICT' : 'FILE_UNWRITABLE', messageOf(error), relative)]); }
      this.scan('view');
      return this.snapshot().views.find(candidate => candidate.id === id)!;
    });
  }

  saveConfiguration(input: unknown, revision: string): Promise<{ config: ProtocolConfiguration; revision: string; diagnostics: Diagnostic[] }> {
    return this.serialize(() => {
      if (typeof revision !== 'string' || !revision) throw new WorkspaceError(400, 'A configuration revision is required');
      this.scan('refresh');
      this.assertWritable(false);
      if (revision !== this.configRevision) throw new WorkspaceError(409, 'Configuration revision conflict', undefined,
        [diagnostic('REVISION_CONFLICT', 'Configuration changed on disk', '.pm/config.yaml')]);
      let candidate: ProtocolConfiguration;
      try { candidate = parseConfiguration(input); }
      catch (error) { throw new WorkspaceError(422, messageOf(error), undefined, diagnosticsOf(error, { path: '.pm/config.yaml' })); }
      const errors = this.validateConfigurationFiles(candidate, this.repository.collect());
      if (errors.length) throw new WorkspaceError(422, 'Configuration is incompatible with workspace sources', undefined, errors);
      const raw = stringify(candidate);
      if (Buffer.byteLength(raw, 'utf8') > maxRepositoryFileBytes) throw new WorkspaceError(422, 'Configuration exceeds the 4 MiB limit');
      try { this.repository.write('.pm/config.yaml', raw, revision === 'absent' ? undefined : revision); }
      catch (error) { throw new WorkspaceError(error instanceof RepositoryConflict ? 409 : 422, messageOf(error), undefined,
        [diagnostic(error instanceof RepositoryConflict ? 'REVISION_CONFLICT' : 'FILE_UNWRITABLE', messageOf(error), '.pm/config.yaml')]); }
      this.scan('configuration');
      return this.configuration();
    });
  }

  migration(action: 'preview' | 'apply' | 'restore' | 'list', input?: unknown): Promise<unknown> {
    return this.serialize(() => {
      this.scan('refresh');
      try {
        if (action === 'list') return this.migrations.list();
        this.assertWritable(false);
        if (action === 'preview') return this.migrations.preview(input as MigrationRequest);
        if (action !== 'apply' && action !== 'restore') throw new WorkspaceError(400, 'Unknown migration action');
        if (!plainObject(input) || typeof input.id !== 'string' || typeof input.revision !== 'string') throw new WorkspaceError(400, 'Migration id and revision are required');
        const result = this.migrations[action]({ id: input.id, revision: input.revision });
        this.scan('migration', result.files.map(file => ({ path: file.path,
          fromRevision: result.status === 'applied' ? file.beforeRevision : file.afterRevision,
          toRevision: result.status === 'applied' ? file.afterRevision : file.beforeRevision })));
        return result;
      } catch (error) {
        // A journal may have become unresolved after a partial filesystem failure.
        this.scan('migration-error');
        if (error instanceof WorkspaceError) throw error;
        const diagnostics = diagnosticsOf(error);
        throw new WorkspaceError(error instanceof RepositoryConflict || diagnostics.some(item => /CONFLICT|PENDING|TAMPERED/.test(item.code)) ? 409 : 422,
          messageOf(error), undefined, diagnostics);
      }
    });
  }

  context(id: string, visible?: (record: FileRecord) => boolean): { id: string; markdown: string } {
    const primary = this.get(id);
    const linked = new Map<string, string[]>();
    for (const edge of this.projection.related(id)) {
      const target = edge.source === id ? edge.target : edge.source;
      if (target === id) continue;
      if (visible) { const related = this.projection.get(target); if (!related || !visible(related)) continue; }
      const label = edge.kind === 'related_to' || edge.source === id ? edge.kind : `backlink:${edge.kind}`;
      linked.set(target, [...(linked.get(target) ?? []), label]);
    }
    const lines = [
      `# Agent context: ${id} — ${primary.entity.title}`, '',
      '> Markdown files are the source of truth. Re-read the revision before writing.',
      ...(primary.stale ? [`> WARNING: ${primary.error}; the entity projection is last-known-good but raw source is current.`] : []),
      '', `Path: ${primary.path}`, `Revision: ${primary.revision}`, '', primary.raw,
      '', '## Related context', '',
    ];
    for (const [target, kinds] of linked) {
      const record = this.projection.get(target);
      lines.push(`### ${target} (${kinds.join(', ')})`, '');
      if (!record) { lines.push('Unresolved reference: no indexed entity found.', ''); continue; }
      if (record.stale) lines.push(`> WARNING: stale projection — ${record.error}`, '');
      lines.push(`Path: ${record.path}`, `Revision: ${record.revision}`, '', record.raw, '');
    }
    if (!linked.size) lines.push('No related entities.');
    return { id, markdown: lines.join('\n') };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    await this.watcher?.close();
    await this.pending;
    this.events.removeAllListeners();
    this.projection?.close();
  }
}
