import { DatabaseSync } from 'node:sqlite';
import { defaultConfiguration, type Diagnostic, type Entity, type EntityKind, type FileRecord, type ProtocolConfiguration, type SavedView, type UnsupportedFile, type ViewConfig, type WorkspaceSnapshot } from '../pm-schema/index.ts';
import { createReferenceResolver, referenceEntries } from '../pm-schema/relations.ts';
import { applyView } from '../pm-schema/query.ts';

export type ItemQuery = { entity?: EntityKind; project?: string; status?: string; priority?: string; q?: string; sort?: string; archived?: 'exclude' | 'include' | 'only' };
export type Relationship = { source: string; target: string; kind: string };

/** Disposable projection: every row can be rebuilt from Markdown and saved-view YAML. */
export class Projection {
  readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, raw TEXT NOT NULL, revision TEXT NOT NULL,
        entity_json TEXT NOT NULL, entity_kind TEXT NOT NULL, title TEXT NOT NULL,
        project TEXT, status TEXT, priority TEXT, stale INTEGER NOT NULL DEFAULT 0, error TEXT
      );
      CREATE INDEX IF NOT EXISTS files_query ON files(entity_kind, project, status, priority);
      CREATE TABLE IF NOT EXISTS relationships (
        source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL,
        PRIMARY KEY (source, target, kind)
      );
      CREATE INDEX IF NOT EXISTS relationships_target ON relationships(target);
      CREATE TABLE IF NOT EXISTS diagnostics (value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS unsupported (path TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS views (id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS configuration (id INTEGER PRIMARY KEY CHECK (id = 1), value_json TEXT NOT NULL);
    `);
    const columns = new Set(this.db.prepare('PRAGMA table_info(files)').all().map(row => String(row.name)));
    if (!columns.has('diagnostics_json')) this.db.exec('ALTER TABLE files ADD COLUMN diagnostics_json TEXT');
    if (!columns.has('archived')) this.db.exec('ALTER TABLE files ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  }

  private record(row: Record<string, unknown>): FileRecord {
    return {
      id: String(row.id), path: String(row.path), raw: String(row.raw), revision: String(row.revision),
      entity: JSON.parse(String(row.entity_json)) as Entity,
      ...(row.stale ? { stale: true, error: String(row.error ?? 'File is not synchronized') } : {}),
      ...(row.diagnostics_json ? { diagnostics: JSON.parse(String(row.diagnostics_json)) as Diagnostic[] } : {}),
    };
  }

  hasSnapshot(): boolean {
    return this.db.prepare('SELECT 1 FROM configuration WHERE id = 1').get() !== undefined;
  }

  snapshot(): WorkspaceSnapshot {
    const stored = this.db.prepare('SELECT value_json FROM configuration WHERE id = 1').get();
    const configuration = stored ? JSON.parse(String(stored.value_json)) as Pick<WorkspaceSnapshot, 'configuration' | 'configurationRevision' | 'configurationErrors'>
      : { configuration: defaultConfiguration, configurationRevision: 'absent', configurationErrors: [] };
    return {
      ...configuration,
      files: this.db.prepare('SELECT * FROM files ORDER BY id').all().map(row => this.record(row)),
      errors: this.db.prepare('SELECT value_json FROM diagnostics ORDER BY rowid').all().map(row => JSON.parse(String(row.value_json)) as Diagnostic),
      unsupportedFiles: this.db.prepare('SELECT value_json FROM unsupported ORDER BY path').all().map(row => JSON.parse(String(row.value_json)) as UnsupportedFile),
      views: this.db.prepare('SELECT config_json FROM views ORDER BY id').all().map(row => JSON.parse(String(row.config_json)) as SavedView),
    };
  }

  get(id: string): FileRecord | undefined {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id);
    return row ? this.record(row) : undefined;
  }

  items(query: ItemQuery = {}): FileRecord[] {
    const filter: Record<string, string> = {};
    for (const field of ['status', 'priority'] as const) if (query[field]) filter[field] = query[field];
    return this.query({ entity: query.entity ?? 'work_item', layout: 'table', ...(query.project ? { project: query.project } : {}),
      ...(Object.keys(filter).length ? { filter } : {}), sort: query.sort ?? 'id' }, { ...(query.q === undefined ? {} : { search: query.q }), ...(query.archived === undefined ? {} : { archived: query.archived }) });
  }

  query(view: ViewConfig, options: { search?: string; archived?: 'exclude' | 'include' | 'only' } = {}): FileRecord[] {
    const snapshot = this.snapshot();
    return applyView(snapshot.files, view, { ...options, configuration: snapshot.configuration });
  }

  related(id: string): Relationship[] {
    return this.db.prepare('SELECT source, target, kind FROM relationships WHERE source = ? OR target = ? ORDER BY kind, source, target').all(id, id).map(row => ({ source: String(row.source), target: String(row.target), kind: String(row.kind) }));
  }

  replace(files: FileRecord[], errors: Diagnostic[], views: SavedView[], unsupportedFiles: UnsupportedFile[],
    configuration: ProtocolConfiguration, configurationRevision: string, configurationErrors: Diagnostic[]): void {
    const insertFile = this.db.prepare('INSERT INTO files (id,path,raw,revision,entity_json,entity_kind,title,project,status,priority,stale,error,diagnostics_json,archived) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertEdge = this.db.prepare('INSERT OR IGNORE INTO relationships (source,target,kind) VALUES (?,?,?)');
    const insertError = this.db.prepare('INSERT INTO diagnostics (value_json) VALUES (?)');
    const insertView = this.db.prepare('INSERT INTO views (id,config_json) VALUES (?,?)');
    const insertUnsupported = this.db.prepare('INSERT INTO unsupported (path,value_json) VALUES (?,?)');
    const resolver = createReferenceResolver(files);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM files; DELETE FROM relationships; DELETE FROM diagnostics; DELETE FROM views; DELETE FROM unsupported;');
      for (const file of files) {
        const entity = file.entity;
        insertFile.run(file.id, file.path, file.raw, file.revision, JSON.stringify(entity), entity.entity, entity.title,
          entity.project ?? null, entity.status ?? null, entity.priority ?? null, file.stale ? 1 : 0, file.error ?? null, file.diagnostics ? JSON.stringify(file.diagnostics) : null, entity.archived ? 1 : 0);
        for (const { field, targetId } of referenceEntries(entity, configuration)) insertEdge.run(file.id, targetId, field);
        for (const target of entity.links) {
          const resolved = resolver.resolve(target).file?.id ?? target;
          insertEdge.run(file.id, resolved, 'link');
        }
      }
      for (const error of errors) insertError.run(JSON.stringify(error));
      for (const file of unsupportedFiles) insertUnsupported.run(file.path, JSON.stringify(file));
      for (const view of views) insertView.run(view.id, JSON.stringify(view));
      this.db.prepare('INSERT OR REPLACE INTO configuration (id,value_json) VALUES (1,?)')
        .run(JSON.stringify({ configuration, configurationRevision, configurationErrors }));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }
}
