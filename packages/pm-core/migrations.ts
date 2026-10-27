import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { isMap, isScalar, parseDocument, stringify, type Document } from 'yaml';
import { z } from 'zod';
import { inspectFrontmatter, inspectMarkdown, parseMarkdown } from '../pm-markdown/index.ts';
import { defaultConfiguration, diagnosticsOf, fieldRegistry, parseConfiguration, ProtocolError, type Diagnostic, type FileRecord, type ProtocolConfiguration, type ViewConfig } from '../pm-schema/index.ts';
import { validateRelations } from '../pm-schema/relations.ts';
import { validateView } from '../pm-schema/query.ts';
import { FileRepository, maxRepositoryFileBytes, RepositoryConflict, revisionOf, type DiskFile } from './repository.ts';
import { DurableState, requestHash as hash } from './state.ts';

export interface MigrationRequest {
  kind: 'normalize-v1' | 'transform';
  config?: ProtocolConfiguration;
  changes?: { id: string; set?: Record<string, unknown>; rename?: Record<string, string>; unset?: string[] }[];
}
export interface MigrationFile { path: string; before: string | null; after: string | null; beforeRevision: string; afterRevision: string }
export interface MigrationPlan {
  id: string;
  revision: string;
  kind: MigrationRequest['kind'];
  createdAt: string;
  files: MigrationFile[];
  diagnostics: Diagnostic[];
}
export interface MigrationResult { id: string; revision: string; status: 'applied' | 'restored'; files: MigrationFile[] }
export interface MigrationTransition { path: string; fromRevision: string; toRevision: string }
export interface MigrationSummary {
  id: string;
  revision: string;
  kind: MigrationRequest['kind'];
  createdAt: string;
  status: 'preview' | 'applying' | 'applied' | 'restoring' | 'restored';
  files: number;
  diagnostics: Diagnostic[];
}

const directory = '.pm/state/migrations';
const journalPath = `${directory}/journal.json`;
const configPath = '.pm/config.yaml';
const statePath = '.pm/state/state.json';
const maxArtifactBytes = 4 * 1024 * 1024;
const chunkLength = 256 * 1024; // At most 1 MiB UTF-8, including four-byte code points.
const idSchema = z.string().regex(/^mig-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const revisionSchema = z.union([hashSchema, z.literal('absent')]);
const stableId = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
const contentPath = (value: string): boolean => !value.includes('\\') && !value.includes('\0') && !value.startsWith('/')
  && value.split('/').every(part => !!part && part !== '.' && part !== '..') && !value.startsWith('.pm/') && /\.md$/i.test(value);
const viewPath = (value: string): boolean => value.startsWith('.pm/views/') && !value.includes('\\') && !value.includes('\0')
  && value.split('/').every(part => !!part && part !== '.' && part !== '..') && /\.ya?ml$/i.test(value);
const sourcePathSchema = z.string().refine(value => value === configPath || contentPath(value));
const inputPathSchema = z.string().refine(value => value === configPath || value === statePath || contentPath(value) || viewPath(value));
const blobSchema = z.object({ revision: hashSchema, size: z.number().int().nonnegative(), parts: z.number().int().positive() }).strict();
type Blob = z.infer<typeof blobSchema>;
const changeSchema = z.object({ id: stableId, set: z.record(z.string(), z.unknown()).optional(), rename: z.record(z.string(), z.string()).optional(), unset: z.array(z.string()).optional() }).strict();
const requestSchema = z.object({ kind: z.enum(['normalize-v1', 'transform']), config: z.unknown().optional(), changes: z.array(changeSchema).optional() }).strict();
const diagnosticSchema = z.object({ code: z.string(), severity: z.enum(['error', 'warning']), path: z.string(), message: z.string(), entityId: z.string().optional(), field: z.string().optional(), targetId: z.string().optional(), line: z.number().int().positive().optional() }).strict();
const fingerprintSchema = z.array(z.object({ path: inputPathSchema, revision: revisionSchema }).strict());
type Fingerprints = z.infer<typeof fingerprintSchema>;
interface MigrationSnapshot { files: DiskFile[]; views: DiskFile[]; config: string | null; state: string | null; inputs: Fingerprints }
const storedFileSchema = z.object({ path: sourcePathSchema, before: blobSchema.nullable(), after: blobSchema.nullable(), beforeRevision: revisionSchema, afterRevision: revisionSchema }).strict();
const manifestSchema = z.object({
  version: z.literal(1), id: idSchema, revision: hashSchema, kind: z.enum(['normalize-v1', 'transform']), createdAt: z.string().datetime(),
  request: requestSchema, files: z.array(storedFileSchema), inputs: fingerprintSchema, diagnostics: z.array(diagnosticSchema),
  audit: z.object({ configuration: blobSchema.nullable(), state: blobSchema.nullable() }).strict(),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
const materializeDiagnostic = (item: z.infer<typeof diagnosticSchema>): Diagnostic => ({
  code: item.code, severity: item.severity, path: item.path, message: item.message,
  ...(item.entityId === undefined ? {} : { entityId: item.entityId }),
  ...(item.field === undefined ? {} : { field: item.field }),
  ...(item.targetId === undefined ? {} : { targetId: item.targetId }),
  ...(item.line === undefined ? {} : { line: item.line }),
});
const journalSchema = z.object({ version: z.literal(1), id: idSchema, revision: hashSchema, direction: z.enum(['apply', 'restore']), inputs: fingerprintSchema }).strict();
type Journal = z.infer<typeof journalSchema>;
const statusSchema = z.object({ version: z.literal(1), id: idSchema, revision: hashSchema, status: z.enum(['applied', 'restored']), acknowledged: z.array(sourcePathSchema), checksum: hashSchema }).strict();
type MigrationStatus = z.infer<typeof statusSchema> & { sourceRevision: string };
const byteRevision = (raw: string | null): string => raw === null ? 'absent' : revisionOf(raw);
const failure = (code: string, message: string, path = ''): ProtocolError => new ProtocolError([{ code, severity: 'error', path, message }]);
const optionalRead = (repository: FileRepository, path: string): string | null => {
  try { return repository.read(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
};
function parseYaml(raw: string): unknown {
  const document = parseDocument(raw, { uniqueKeys: true });
  if (document.errors.length) throw failure('YAML_SYNTAX', document.errors.map(error => error.message).join('; '));
  return document.toJS({ maxAliasCount: 100 });
}
function configuration(raw: string | null): ProtocolConfiguration {
  return raw === null ? defaultConfiguration : parseConfiguration(parseYaml(raw));
}
function uniquePaths(inputs: { path: string }[]): boolean { return new Set(inputs.map(input => input.path)).size === inputs.length; }
function boundedJson(value: unknown): string {
  const raw = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(raw) > maxArtifactBytes) throw failure('MIGRATION_LIMIT', 'Migration manifest or journal exceeds the 4 MiB safety limit');
  return raw;
}
function assertSourceSize(raw: string | null, filename: string): void {
  if (raw !== null && Buffer.byteLength(raw) > maxRepositoryFileBytes) {
    throw failure('MIGRATION_LIMIT', 'Migration candidate exceeds the repository 4 MiB UTF-8 source limit', filename);
  }
}

/** One serialized durable journal; source writes are always exact-byte compare-and-swap. */
export class MigrationManager {
  private readonly repository: FileRepository;
  constructor(repository: FileRepository) { this.repository = repository; }

  pending(): boolean { return this.journal() !== null; }
  assertWritable(): void {
    if (this.pending()) throw failure('MIGRATION_PENDING', 'An unresolved migration blocks mutations; recover the migration without changing its recorded source bytes', journalPath);
  }

  private journal(): { value: Journal; raw: string } | null {
    const raw = optionalRead(this.repository, journalPath);
    if (raw === null) return null;
    try {
      const value = journalSchema.parse(JSON.parse(raw));
      if (!uniquePaths(value.inputs) || !value.inputs.some(input => input.path === configPath) || !value.inputs.some(input => input.path === statePath)) throw new Error('Incomplete journal inputs');
      return { value, raw };
    } catch { throw failure('MIGRATION_TAMPERED', 'Malformed migration journal; recovery is blocked', journalPath); }
  }

  private blob(id: string, raw: string, written: Map<string, Blob>): Blob {
    const revision = revisionOf(raw);
    const existing = written.get(revision);
    if (existing) return existing;
    const chunks: string[] = [];
    for (let offset = 0; offset < raw.length;) {
      let end = Math.min(raw.length, offset + chunkLength);
      // Never split a surrogate pair: the bytes reassembled on disk must be identical.
      if (end < raw.length && /[\uD800-\uDBFF]/.test(raw[end - 1]!) && /[\uDC00-\uDFFF]/.test(raw[end]!)) end--;
      chunks.push(raw.slice(offset, end));
      offset = end;
    }
    if (!chunks.length) chunks.push('');
    const result = { revision, size: Buffer.byteLength(raw), parts: chunks.length };
    for (let index = 0; index < chunks.length; index++) this.repository.write(`${directory}/${id}/blobs/${revision}-${index}.txt`, chunks[index]!);
    written.set(revision, result);
    return result;
  }

  private readBlob(id: string, blob: Blob | null): string | null {
    if (blob === null) return null;
    // A malicious descriptor cannot cause unbounded reads unrelated to its declared bytes.
    if (blob.parts > Math.max(1, Math.ceil(blob.size / (chunkLength - 1)))) throw failure('MIGRATION_TAMPERED', 'Invalid backup chunk count');
    let raw = '';
    for (let index = 0; index < blob.parts; index++) {
      const part = this.repository.read(`${directory}/${id}/blobs/${blob.revision}-${index}.txt`);
      if (part.length > chunkLength) throw failure('MIGRATION_TAMPERED', 'Oversized migration backup chunk');
      raw += part;
    }
    if (Buffer.byteLength(raw) !== blob.size || revisionOf(raw) !== blob.revision) throw failure('MIGRATION_TAMPERED', 'Migration backup checksum mismatch');
    return raw;
  }

  private load(id: string): { manifest: Manifest; plan: MigrationPlan } {
    if (!idSchema.safeParse(id).success) throw failure('MIGRATION_INVALID', 'Invalid migration ID');
    const filename = `${directory}/${id}/manifest.json`;
    try {
      const manifest = manifestSchema.parse(JSON.parse(this.repository.read(filename)));
      const { revision, ...payload } = manifest;
      if (manifest.id !== id || hash(payload) !== revision || manifest.kind !== manifest.request.kind || !uniquePaths(manifest.files) || !uniquePaths(manifest.inputs)) throw new Error('Manifest integrity mismatch');
      const inputs = new Map(manifest.inputs.map(input => [input.path, input.revision]));
      if (!inputs.has(configPath) || !inputs.has(statePath)) throw new Error('Missing audit inputs');
      const originalConfig = this.readBlob(id, manifest.audit.configuration);
      const originalState = this.readBlob(id, manifest.audit.state);
      if (byteRevision(originalConfig) !== inputs.get(configPath) || byteRevision(originalState) !== inputs.get(statePath)) throw new Error('Audit checksum mismatch');
      const files = manifest.files.map(file => {
        const before = this.readBlob(id, file.before);
        const after = this.readBlob(id, file.after);
        if (byteRevision(before) !== file.beforeRevision || byteRevision(after) !== file.afterRevision || inputs.get(file.path) !== file.beforeRevision || before === after) throw new Error('File checksum mismatch');
        if (file.path !== configPath) {
          if (before === null || after === null) throw new Error('Migrations cannot create or remove entities');
          const prior = inspectFrontmatter(before).metadata;
          const next = inspectFrontmatter(after).metadata;
          if (prior.schema !== 'pm/v1' || next.schema !== prior.schema || next.id !== prior.id || next.entity !== prior.entity || !stableId.safeParse(prior.id).success) throw new Error('Migration cannot change schema or identity');
        } else if (after === null) throw new Error('Apply cannot remove configuration');
        return { path: file.path, before, after, beforeRevision: file.beforeRevision, afterRevision: file.afterRevision };
      });
      return { manifest, plan: { id, revision, kind: manifest.kind, createdAt: manifest.createdAt, files, diagnostics: manifest.diagnostics.map(materializeDiagnostic) } };
    } catch (error) {
      if (error instanceof ProtocolError && error.diagnostics.some(item => item.code === 'MIGRATION_TAMPERED')) throw error;
      throw failure('MIGRATION_TAMPERED', `Cannot read verified migration manifest or backups: ${(error as Error).message}`, filename);
    }
  }

  private status(manifest: Manifest): MigrationStatus | null {
    const filename = `${directory}/${manifest.id}/status.json`;
    const raw = optionalRead(this.repository, filename);
    if (raw === null) return null;
    try {
      const state = statusSchema.parse(JSON.parse(raw));
      const { checksum, ...payload } = state;
      if (state.id !== manifest.id || state.revision !== manifest.revision || hash(payload) !== checksum
        || new Set(state.acknowledged).size !== state.acknowledged.length
        || state.acknowledged.some(path => !manifest.files.some(file => file.path === path))) throw new Error('Status integrity mismatch');
      return { ...state, sourceRevision: revisionOf(raw) };
    } catch { throw failure('MIGRATION_TAMPERED', 'Malformed migration status', filename); }
  }

  private snapshot(): MigrationSnapshot {
    const disk = this.repository.collect();
    if (disk.errors.length) throw new ProtocolError(disk.errors.map(item => ({ code: 'MIGRATION_UNSAFE_PATH', severity: 'error', ...item })));
    const config = optionalRead(this.repository, configPath);
    const state = optionalRead(this.repository, statePath);
    const inputs = [...disk.files, ...disk.views].map(file => ({ path: file.path, revision: revisionOf(file.raw) }));
    inputs.push({ path: configPath, revision: byteRevision(config) }, { path: statePath, revision: byteRevision(state) });
    inputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { files: disk.files, views: disk.views, config, state, inputs };
  }

  private ledger(): DurableState | undefined {
    if (optionalRead(this.repository, statePath) === null) return undefined;
    const state = new DurableState(this.repository);
    if (state.transaction) throw failure('MIGRATION_PENDING', 'A pending entity transaction must be recovered before migration', statePath);
    if (state.migrationProjection) throw failure('MIGRATION_PENDING', 'A pending migration projection must be reconciled before another migration', statePath);
    return state;
  }

  private validate(files: DiskFile[], views: DiskFile[], config: ProtocolConfiguration, normalize = false): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const records: FileRecord[] = [];
    let state: DurableState | undefined;
    try { state = this.ledger(); } catch (error) { diagnostics.push(...diagnosticsOf(error, { path: statePath })); }
    for (const file of files) {
      try {
        assertSourceSize(file.raw, file.path);
        const raw = normalize ? this.normalize(file.raw, file.path, config) : file.raw;
        const entity = parseMarkdown(raw, config);
        const known = state?.identity(file.path);
        if (state?.deleted(entity.id)) throw failure('ID_TOMBSTONED', `Migration cannot restore deleted identity ${entity.id}`, file.path);
        if (known && (known.id !== entity.id || known.entity && known.entity !== entity.entity)) throw failure('IMMUTABLE_FIELD', 'Migration source disagrees with durable identity', file.path);
        records.push({ id: entity.id, path: file.path, raw, revision: revisionOf(raw), entity });
      } catch (error) { diagnostics.push(...diagnosticsOf(error, { path: file.path })); }
    }
    for (const view of views) {
      try { validateView(parseYaml(view.raw) as ViewConfig, config); }
      catch (error) { diagnostics.push(...diagnosticsOf(error, { path: view.path })); }
    }
    diagnostics.push(...validateRelations(records, config));
    return diagnostics;
  }

  private normalize(raw: string, filename: string, config: ProtocolConfiguration): string {
    const section = inspectFrontmatter(raw);
    if (section.metadata.schema !== 'pm/v1') throw failure('UNSUPPORTED_SCHEMA_VERSION', 'Migration cannot interpret or downgrade an unknown schema', filename);
    let changed = false;
    if (section.metadata.entity === 'project' && section.metadata.status === 'in_progress'
      && !config.workflows.project?.states.some(state => state.id === 'in_progress')) {
      this.setNode(section.document, 'status', 'active'); changed = true;
    }
    if (section.metadata.entity === 'document' && ['todo', 'in_progress', 'done', 'canceled'].includes(String(section.metadata.status))) {
      section.document.delete('status');
      if (section.metadata.document_kind === undefined) {
        const adr = /^ADR-/i.test(String(section.metadata.id)) || /^ADR(?:[-_.]|$)/i.test(filename.split('/').at(-1)!);
        this.setNode(section.document, 'document_kind', adr ? 'decision' : 'note');
      }
      changed = true;
    }
    return changed ? `${section.opening}${section.document.toString().replace(/\r?\n/g, section.newline)}${section.closing}${section.body}` : raw;
  }

  private setNode(document: Document, field: string, value: unknown): void {
    const previous = document.get(field, true);
    const next = document.createNode(value);
    if (previous && typeof previous === 'object') {
      for (const property of ['comment', 'commentBefore', 'spaceBefore', 'anchor', 'flow'] as const) {
        if (property in previous) Object.assign(next, { [property]: Reflect.get(previous, property) });
      }
      if (isScalar(previous) && isScalar(next)) next.type = previous.type!;
    }
    document.set(field, next);
  }

  private transform(raw: string, change: NonNullable<MigrationRequest['changes']>[number], before: ProtocolConfiguration, after: ProtocolConfiguration): string {
    const section = inspectFrontmatter(raw);
    if (section.metadata.schema !== 'pm/v1') throw failure('UNSUPPORTED_SCHEMA_VERSION', 'Migration cannot downgrade an unknown schema');
    const custom = (name: string, config: ProtocolConfiguration): boolean => config.custom_fields.some(field => field.name === name && field.entities.some(kind => kind === section.metadata.entity));
    const allowed = (name: string, removal = false): void => {
      const definition = fieldRegistry.find(field => field.name === name);
      if (['schema', 'id', 'entity'].includes(name)) throw failure('IMMUTABLE_FIELD', `Migration cannot change ${name}`);
      if (definition && (!definition.editable || definition.source !== 'yaml')) throw failure('DERIVED_FIELD', `Migration cannot change ${name}`);
      if (name !== 'status' && !(custom(name, after) || removal && custom(name, before))) throw failure('MIGRATION_FIELD', `Migration fields must be status or registered custom fields: ${name}`);
    };
    const touched = new Set<string>();
    const touch = (name: string): void => {
      if (touched.has(name)) throw failure('MIGRATION_INVALID', `Conflicting operations for field ${name}`);
      touched.add(name);
    };
    for (const [source, target] of Object.entries(change.rename ?? {})) {
      allowed(source, true); allowed(target);
      if (source === 'status' || target === 'status') throw failure('MIGRATION_FIELD', 'Only registered custom fields can be renamed');
      touch(source); touch(target);
      if (!section.document.has(source) || section.document.has(target)) throw failure('MIGRATION_INVALID', `Rename requires existing ${source} and absent ${target}`);
      // Rename the key, retaining value nodes, aliases and their comments.
      if (!isMap(section.document.contents)) throw failure('MIGRATION_INVALID', 'Expected YAML mapping');
      const pair = section.document.contents.items.find(item => isScalar(item.key) && item.key.value === source);
      if (!pair || !isScalar(pair.key)) throw failure('MIGRATION_INVALID', `Missing scalar key ${source}`);
      pair.key.value = target;
    }
    for (const name of change.unset ?? []) { allowed(name, true); touch(name); section.document.delete(name); }
    for (const [name, value] of Object.entries(change.set ?? {})) {
      allowed(name); touch(name);
      if (value === null) section.document.delete(name);
      else this.setNode(section.document, name, value);
    }
    if (!touched.size) return raw;
    return `${section.opening}${section.document.toString().replace(/\r?\n/g, section.newline)}${section.closing}${section.body}`;
  }

  preview(input: MigrationRequest): MigrationPlan {
    this.assertWritable();
    let request: MigrationRequest;
    try {
      hash(input as unknown as Record<string, unknown>); // Reject non-JSON direct callers, not only HTTP callers.
      const parsed = requestSchema.parse(input);
      request = { ...parsed, ...(parsed.config === undefined ? {} : { config: parseConfiguration(parsed.config) }) } as MigrationRequest;
      if (request.kind === 'normalize-v1' && request.changes?.length) throw new Error('normalize-v1 does not accept explicit changes');
      if (new Set((request.changes ?? []).map(change => change.id)).size !== (request.changes ?? []).length) throw new Error('Each entity may appear only once');
    } catch (error) { throw failure('MIGRATION_INVALID', `Invalid migration request: ${(error as Error).message}`); }
    const snapshot = this.snapshot();
    const diagnostics: Diagnostic[] = [];
    let originalConfig = defaultConfiguration;
    try { originalConfig = configuration(snapshot.config); }
    catch (error) { diagnostics.push(...diagnosticsOf(error, { path: configPath })); }
    const candidateConfig = request.config ?? originalConfig;
    const rawConfig = request.config === undefined || snapshot.config !== null && hash(candidateConfig as unknown as Record<string, unknown>) === hash(originalConfig as unknown as Record<string, unknown>)
      ? snapshot.config : stringify(candidateConfig);
    const candidates = new Map(snapshot.files.map(file => [file.path, file.raw]));
    if (request.kind === 'normalize-v1') {
      for (const file of snapshot.files) {
        try { candidates.set(file.path, this.normalize(file.raw, file.path, originalConfig)); }
        catch (error) { diagnostics.push(...diagnosticsOf(error, { path: file.path })); }
      }
    } else {
      const byId = new Map<string, DiskFile[]>();
      for (const file of snapshot.files) {
        const id = inspectMarkdown(file.raw).id;
        if (id) byId.set(id, [...(byId.get(id) ?? []), file]);
      }
      for (const change of request.changes ?? []) {
        const matches = byId.get(change.id);
        if (matches?.length !== 1) {
          diagnostics.push({ code: matches?.length ? 'DUPLICATE_ID' : 'NOT_FOUND', severity: 'error', path: '', entityId: change.id, message: `Migration requires exactly one existing ${change.id}` });
          continue;
        }
        const file = matches![0]!;
        try { candidates.set(file.path, this.transform(file.raw, change, originalConfig, candidateConfig)); }
        catch (error) { diagnostics.push(...diagnosticsOf(error, { path: file.path, entityId: change.id })); }
      }
    }
    try { assertSourceSize(rawConfig, configPath); }
    catch (error) { diagnostics.push(...diagnosticsOf(error, { path: configPath })); }
    diagnostics.push(...this.validate([...candidates].map(([path, raw]) => ({ path, raw })), snapshot.views, candidateConfig));
    const files: MigrationFile[] = snapshot.files.flatMap(file => {
      const after = candidates.get(file.path)!;
      return after === file.raw ? [] : [{ path: file.path, before: file.raw, after, beforeRevision: revisionOf(file.raw), afterRevision: revisionOf(after) }];
    });
    if (rawConfig !== snapshot.config) files.push({ path: configPath, before: snapshot.config, after: rawConfig, beforeRevision: byteRevision(snapshot.config), afterRevision: byteRevision(rawConfig) });
    const id = `mig-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.repository.mkdir(`${directory}/${id}/blobs`);
    const written = new Map<string, Blob>();
    const store = (raw: string | null): Blob | null => raw === null ? null : this.blob(id, raw, written);
    const payload = {
      version: 1 as const, id, kind: request.kind, createdAt, request, inputs: snapshot.inputs, diagnostics,
      files: files.map(file => ({ ...file, before: store(file.before), after: store(file.after) })),
      audit: { configuration: store(snapshot.config), state: store(snapshot.state) },
    };
    const revision = hash(payload);
    this.repository.write(`${directory}/${id}/manifest.json`, boundedJson({ ...payload, revision }));
    return { id, revision, kind: request.kind, createdAt, files, diagnostics };
  }

  private verifyInputs(expected: Fingerprints, files: MigrationFile[] = [], mixed = false, direction: Journal['direction'] = 'apply'): MigrationSnapshot {
    const current = this.snapshot();
    const permitted = new Map(files.map(file => [file.path, mixed ? [file.beforeRevision, file.afterRevision] : [direction === 'apply' ? file.beforeRevision : file.afterRevision]]));
    if (current.inputs.length !== expected.length) throw failure('MIGRATION_CONFLICT', 'Workspace paths changed since migration review');
    const actual = new Map(current.inputs.map(input => [input.path, input.revision]));
    for (const input of expected) {
      if (!(permitted.get(input.path) ?? [input.revision]).includes(actual.get(input.path)!)) throw failure('MIGRATION_CONFLICT', 'Workspace input changed since migration review', input.path);
    }
    return current;
  }

  private validateTarget(snapshot: MigrationSnapshot, plan: MigrationPlan, direction: Journal['direction']): void {
    const replacements = new Map(plan.files.map(file => [file.path, direction === 'apply' ? file.after : file.before]));
    const files: DiskFile[] = snapshot.files.map(file => {
      const raw = replacements.has(file.path) ? replacements.get(file.path)! : file.raw;
      if (raw === null) throw failure('MIGRATION_TAMPERED', 'Migration cannot delete Markdown files');
      return { path: file.path, raw };
    });
    const rawConfig = replacements.has(configPath) ? replacements.get(configPath)! : snapshot.config;
    assertSourceSize(rawConfig, configPath);
    let config: ProtocolConfiguration;
    try { config = configuration(rawConfig); }
    catch (error) { throw new ProtocolError(diagnosticsOf(error, { path: configPath })); }
    const diagnostics = this.validate(files, snapshot.views, config, direction === 'restore' && plan.kind === 'normalize-v1');
    if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) throw new ProtocolError(diagnostics);
  }

  private confirmed(input: { id: string; revision: string }): { manifest: Manifest; plan: MigrationPlan } {
    if (!input || !idSchema.safeParse(input.id).success || !hashSchema.safeParse(input.revision).success) throw failure('MIGRATION_INVALID', 'Explicit migration ID and revision are required');
    const loaded = this.load(input.id);
    if (loaded.plan.revision !== input.revision) throw failure('MIGRATION_CONFLICT', 'Migration preview revision does not match');
    if (loaded.plan.diagnostics.some(item => item.severity === 'error')) throw new ProtocolError(loaded.plan.diagnostics);
    const { manifest, plan } = loaded;
    try {
      const originalRaw = this.readBlob(plan.id, manifest.audit.configuration);
      const originalConfig = configuration(originalRaw);
      const candidateConfig = manifest.request.config === undefined ? originalConfig : parseConfiguration(manifest.request.config);
      const changes: NonNullable<MigrationRequest['changes']> = (manifest.request.changes ?? []).map(({ id, set, rename, unset }) => ({
        id,
        ...(set === undefined ? {} : { set }),
        ...(rename === undefined ? {} : { rename }),
        ...(unset === undefined ? {} : { unset }),
      }));
      if (new Set(changes.map(change => change.id)).size !== changes.length || manifest.kind === 'normalize-v1' && changes.length) throw new Error('Invalid declarative changes');
      for (const file of plan.files) {
        let expected: string | null;
        if (file.path === configPath) {
          if (manifest.request.config === undefined) throw new Error('Unrequested configuration change');
          expected = originalRaw !== null && hash(candidateConfig as unknown as Record<string, unknown>) === hash(originalConfig as unknown as Record<string, unknown>)
            ? originalRaw : stringify(candidateConfig);
        } else if (manifest.kind === 'normalize-v1') {
          expected = this.normalize(file.before!, file.path, originalConfig);
        } else {
          const change = changes.find(change => change.id === inspectMarkdown(file.before!).id);
          if (!change) throw new Error('Unrequested entity change');
          expected = this.transform(file.before!, change, originalConfig, candidateConfig);
        }
        if (file.after !== expected) throw new Error('Candidate does not match the declarative request');
      }
    } catch (error) {
      throw failure('MIGRATION_TAMPERED', `Migration intent verification failed: ${(error as Error).message}`);
    }
    return loaded;
  }

  apply(input: { id: string; revision: string }): MigrationResult {
    this.assertWritable();
    const { manifest, plan } = this.confirmed(input);
    if (this.status(manifest) !== null) throw failure('MIGRATION_INVALID', 'Only an unapplied preview can be applied');
    const snapshot = this.verifyInputs(manifest.inputs);
    this.validateTarget(snapshot, plan, 'apply');
    return this.begin(plan, 'apply', snapshot.inputs);
  }

  restore(input: { id: string; revision: string }): MigrationResult {
    this.assertWritable();
    const { manifest, plan } = this.confirmed(input);
    if (this.status(manifest)?.status !== 'applied') throw failure('MIGRATION_INVALID', 'Only an applied migration can be restored');
    const snapshot = this.snapshot();
    this.verifyInputs(snapshot.inputs, plan.files, false, 'restore');
    this.validateTarget(snapshot, plan, 'restore');
    return this.begin(plan, 'restore', snapshot.inputs);
  }

  private begin(plan: MigrationPlan, direction: Journal['direction'], inputs: Fingerprints): MigrationResult {
    const journal: Journal = { version: 1, id: plan.id, revision: plan.revision, direction, inputs };
    this.repository.write(journalPath, boundedJson(journal));
    try { this.recover(); }
    catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw failure(error instanceof RepositoryConflict ? 'MIGRATION_CONFLICT' : 'MIGRATION_PENDING', `Migration remains pending: ${(error as Error).message}`);
    }
    return { id: plan.id, revision: plan.revision, status: direction === 'apply' ? 'applied' : 'restored', files: plan.files };
  }

  recover(): void {
    const journal = this.journal();
    if (!journal) return;
    const { manifest, plan } = this.confirmed({ id: journal.value.id, revision: journal.value.revision });
    const { direction, inputs } = journal.value;
    const status = this.status(manifest)?.status ?? 'preview';
    if (direction === 'apply' && status === 'restored' || direction === 'restore' && status === 'preview') throw failure('MIGRATION_TAMPERED', 'Journal conflicts with migration status');
    if (direction === 'apply' && hash({ inputs }) !== hash({ inputs: manifest.inputs })) throw failure('MIGRATION_TAMPERED', 'Apply journal does not match reviewed inputs');
    const snapshot = this.verifyInputs(inputs, plan.files, true, direction);
    this.validateTarget(snapshot, plan, direction);
    for (const file of plan.files) {
      // Recheck the entire relation/config/state read set before each individual CAS.
      this.verifyInputs(inputs, plan.files, true, direction);
      const target = direction === 'apply' ? file.after : file.before;
      assertSourceSize(target, file.path);
      const source = direction === 'apply' ? file.before : file.after;
      const actual = optionalRead(this.repository, file.path);
      if (actual === target) continue;
      if (actual !== source) throw failure('MIGRATION_CONFLICT', 'Migration recovery encountered external bytes', file.path);
      if (target === null) this.repository.remove(file.path, revisionOf(source!));
      else this.repository.write(file.path, target, source === null ? undefined : revisionOf(source));
    }
    this.verifyInputs(inputs, plan.files, true, direction);
    for (const file of plan.files) {
      if (optionalRead(this.repository, file.path) !== (direction === 'apply' ? file.after : file.before)) {
        throw failure('MIGRATION_CONFLICT', 'Migration target changed before commit', file.path);
      }
    }
    const statusPath = `${directory}/${plan.id}/status.json`;
    const previousStatus = optionalRead(this.repository, statusPath);
    const committedStatus = { version: 1, id: plan.id, revision: plan.revision, status: direction === 'apply' ? 'applied' : 'restored', acknowledged: [] };
    this.repository.write(statusPath, boundedJson({ ...committedStatus, checksum: hash(committedStatus) }), previousStatus === null ? undefined : revisionOf(previousStatus));
    this.repository.remove(journalPath, revisionOf(journal.raw));
  }

  /** Startup may trust a committed migration only for its exact old-to-new source revision pair. */
  completedTransitions(): MigrationTransition[] {
    if (this.pending()) return [];
    return this.list().flatMap(summary => {
      if (summary.status !== 'applied' && summary.status !== 'restored') return [];
      const { manifest, plan } = this.confirmed(summary);
      const status = this.status(manifest)!;
      return plan.files.filter(file => !status.acknowledged.includes(file.path)).map(file => ({
        path: file.path,
        fromRevision: summary.status === 'applied' ? file.beforeRevision : file.afterRevision,
        toRevision: summary.status === 'applied' ? file.afterRevision : file.beforeRevision,
      }));
    });
  }

  /** Call only after durable projection sync; a crash before this CAS leaves exact-pair evidence available. */
  acknowledgeTransitions(transitions: readonly MigrationTransition[]): void {
    if (!transitions.length) return;
    this.assertWritable();
    const accepted = new Set(transitions.map(transition => JSON.stringify([transition.path, transition.fromRevision, transition.toRevision])));
    for (const summary of this.list()) {
      if (summary.status !== 'applied' && summary.status !== 'restored') continue;
      const { manifest, plan } = this.confirmed(summary);
      const status = this.status(manifest)!;
      const acknowledged = new Set(status.acknowledged);
      for (const file of plan.files) {
        const from = summary.status === 'applied' ? file.beforeRevision : file.afterRevision;
        const to = summary.status === 'applied' ? file.afterRevision : file.beforeRevision;
        if (accepted.has(JSON.stringify([file.path, from, to]))) acknowledged.add(file.path);
      }
      if (acknowledged.size === status.acknowledged.length) continue;
      const { checksum: _checksum, sourceRevision, ...payload } = status;
      const next = { ...payload, acknowledged: [...acknowledged] };
      this.repository.write(`${directory}/${summary.id}/status.json`, boundedJson({ ...next, checksum: hash(next) }), sourceRevision);
    }
  }

  list(): MigrationSummary[] {
    let entries: string[];
    try { entries = readdirSync(this.repository.resolve(directory)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const journal = this.journal()?.value;
    return entries.filter(id => idSchema.safeParse(id).success).flatMap<MigrationSummary>(id => {
      // A crash before publishing an immutable manifest leaves only unreachable audit blobs.
      if (optionalRead(this.repository, `${directory}/${id}/manifest.json`) === null) return [];
      const { manifest, plan } = this.load(id);
      const status = journal?.id === id ? journal.direction === 'apply' ? 'applying' as const : 'restoring' as const : this.status(manifest)?.status ?? 'preview';
      return [{ id, revision: plan.revision, kind: plan.kind, createdAt: plan.createdAt, status, files: plan.files.length, diagnostics: plan.diagnostics }];
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
}
