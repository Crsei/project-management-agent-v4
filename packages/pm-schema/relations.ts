import { defaultConfiguration, entityKinds, type Diagnostic, type Entity, type EntityKind, type FileRecord, type ProtocolConfiguration } from './index.ts';

type ReferenceIndex = { ids: Map<string, FileRecord[]>; names: Map<string, Set<FileRecord>> };
function referenceIndex(files: FileRecord[]): ReferenceIndex {
  const ids = new Map<string, FileRecord[]>();
  const names = new Map<string, Set<FileRecord>>();
  for (const file of files) {
    const matches = ids.get(file.id) ?? [];
    matches.push(file);
    ids.set(file.id, matches);
    const basename = file.path.replace(/\\/g, '/').split('/').at(-1)?.replace(/\.md$/i, '') ?? '';
    for (const name of new Set([file.entity.title, basename])) {
      if (!name) continue;
      const named = names.get(name) ?? new Set<FileRecord>();
      named.add(file);
      names.set(name, named);
    }
  }
  return { ids, names };
}
export type ReferenceResolution = { file: FileRecord; reason?: never } | { file?: never; reason: 'missing' | 'ambiguous' };
/** Match the same target that Markdown parsing derives from aliases and section links. */
export function normalizeWikilink(target: string): string {
  return target.split('|', 1)[0]!.split('#', 1)[0]!.trim();
}
function resolveId(target: string, index: ReferenceIndex): ReferenceResolution {
  const ids = index.ids.get(target);
  return !ids ? { reason: 'missing' } : ids.length === 1 ? { file: ids[0]! } : { reason: 'ambiguous' };
}
function resolve(target: string, index: ReferenceIndex): ReferenceResolution {
  const normalized = normalizeWikilink(target);
  if (index.ids.has(normalized)) return resolveId(normalized, index);
  const names = index.names.get(normalized);
  return !names ? { reason: 'missing' } : names.size === 1 ? { file: names.values().next().value! } : { reason: 'ambiguous' };
}
/** Build once per workspace operation; formal fields resolve IDs only, wikilinks also resolve names. */
export function createReferenceResolver(files: FileRecord[]): {
  resolve: (target: string) => ReferenceResolution;
  resolveId: (target: string) => ReferenceResolution;
} {
  const index = referenceIndex(files);
  return { resolve: target => resolve(target, index), resolveId: target => resolveId(target, index) };
}
/** Match exact stable ID first, otherwise an unambiguous title or Markdown basename. */
export function resolveReference(target: string, files: FileRecord[]): FileRecord | undefined {
  return createReferenceResolver(files).resolve(target).file;
}

export interface RelationFieldDefinition {
  name: string;
  entities: EntityKind[];
  multiple: boolean;
  target?: EntityKind | 'self';
  scoped: boolean;
}
const builtInRelations: RelationFieldDefinition[] = [
  { name: 'project', entities: entityKinds.filter((kind) => kind !== 'project'), multiple: false, target: 'project', scoped: false },
  { name: 'parent', entities: ['work_item', 'module'], multiple: false, target: 'self', scoped: true },
  { name: 'parent', entities: ['goal'], multiple: false, target: 'self', scoped: false },
  { name: 'blocked_by', entities: ['work_item'], multiple: true, target: 'work_item', scoped: false },
  { name: 'depends_on', entities: ['project'], multiple: true, target: 'project', scoped: false },
  { name: 'related_to', entities: [...entityKinds], multiple: true, scoped: false },
  { name: 'cycle', entities: ['work_item'], multiple: false, target: 'cycle', scoped: true },
  { name: 'milestone', entities: ['work_item', 'requirement'], multiple: false, target: 'milestone', scoped: true },
  { name: 'module', entities: ['work_item', 'requirement'], multiple: false, target: 'module', scoped: true },
  { name: 'requirement', entities: ['work_item'], multiple: false, target: 'requirement', scoped: true },
  { name: 'release', entities: ['work_item', 'requirement'], multiple: false, target: 'release', scoped: true },
  { name: 'goals', entities: ['project', 'work_item', 'cycle', 'milestone', 'module', 'requirement', 'release'], multiple: true, target: 'goal', scoped: false },
];
/** Shared discovery for validation, projections, delete protection, and reference pickers. */
export function relationFields(configuration: ProtocolConfiguration = defaultConfiguration): RelationFieldDefinition[] {
  return [...builtInRelations, ...configuration.custom_fields.filter((field) => field.type === 'reference').map((field) => ({
    name: field.name, entities: field.entities, multiple: false, ...(field.target === undefined ? {} : { target: field.target }), scoped: false,
  }))];
}
export interface ReferenceEntry { field: string; targetId: string; definition: RelationFieldDefinition }
export function referenceEntries(entity: Entity, configuration: ProtocolConfiguration = defaultConfiguration): ReferenceEntry[] {
  const references: ReferenceEntry[] = [];
  for (const definition of relationFields(configuration)) {
    if (!definition.entities.includes(entity.entity)) continue;
    const value = entity[definition.name];
    const targets = definition.multiple && Array.isArray(value) ? value : [value];
    for (const targetId of new Set(targets)) {
      if (typeof targetId === 'string') references.push({ field: definition.name, targetId, definition });
    }
  }
  return references;
}
type Edge = ReferenceEntry & { source: FileRecord; target?: FileRecord };

/** Iterative strongly connected components avoid recursion limits on long dependency chains. */
function components(graph: Map<string, string[]>): Map<string, number> {
  const visited = new Set<string>();
  const finished: string[] = [];
  for (const root of graph.keys()) {
    if (visited.has(root)) continue;
    visited.add(root);
    const stack = [{ id: root, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const neighbors = graph.get(frame.id) ?? [];
      if (frame.next === neighbors.length) { finished.push(frame.id); stack.pop(); continue; }
      const target = neighbors[frame.next++]!;
      if (!visited.has(target)) { visited.add(target); stack.push({ id: target, next: 0 }); }
    }
  }
  const reverse = new Map<string, string[]>();
  for (const [source, targets] of graph) {
    for (const target of targets) {
      const inbound = reverse.get(target) ?? [];
      inbound.push(source);
      reverse.set(target, inbound);
    }
  }
  const result = new Map<string, number>();
  let component = 0;
  for (let i = finished.length - 1; i >= 0; i--) {
    const root = finished[i]!;
    if (result.has(root)) continue;
    const stack = [root];
    result.set(root, component);
    while (stack.length) {
      for (const target of reverse.get(stack.pop()!) ?? []) {
        if (!result.has(target)) { result.set(target, component); stack.push(target); }
      }
    }
    component++;
  }
  return result;
}

/** Pure candidate-workspace validation, shared by browser drafts and backend writes/scans. */
export function validateRelations(files: FileRecord[], configuration: ProtocolConfiguration = defaultConfiguration): Diagnostic[] {
  const index = referenceIndex(files);
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const invalid = new Set<FileRecord>();
  const invalidQueue: FileRecord[] = [];
  const markInvalid = (file: FileRecord) => {
    if (!invalid.has(file)) { invalid.add(file); invalidQueue.push(file); }
  };
  const add = (file: FileRecord, code: string, field: string, targetId: string, message: string, severity: 'error' | 'warning' = 'error') => {
    const key = JSON.stringify([file.path, file.id, code, field, targetId]);
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push({ code, severity, path: file.path, entityId: file.id, field, targetId, message });
    if (severity === 'error') markInvalid(file);
  };
  for (const file of files) {
    if (file.stale || file.error || file.diagnostics?.some((diagnostic) => diagnostic.severity === 'error')) markInvalid(file);
    if (index.ids.get(file.id)!.length > 1) add(file, 'DUPLICATE_ID', 'id', file.id, `Duplicate stable ID ${file.id}`);
    const dependencies = file.entity.depends_on;
    if (dependencies && new Set(dependencies).size !== dependencies.length)
      add(file, 'DUPLICATE_REFERENCE', 'depends_on', file.id, 'depends_on cannot contain duplicate project dependencies');
  }
  const edges: Edge[] = files.flatMap((source) => referenceEntries(source.entity, configuration).map((entry) => ({ ...entry, source })));
  const inbound = new Map<FileRecord, Edge[]>();
  const cycleGraphs = { parent: new Map<string, string[]>(), blocked_by: new Map<string, string[]>(), depends_on: new Map<string, string[]>() };
  for (const edge of edges) {
    const { source, field, targetId } = edge;
    const targets = index.ids.get(targetId);
    if (!targets) {
      add(source, 'REFERENCE_NOT_FOUND', field, targetId, `${field} references missing ${targetId}`);
      continue;
    }
    if (targets.length !== 1) {
      add(source, 'REFERENCE_INVALID', field, targetId, `${field} references ambiguous ${targetId}`);
      continue;
    }
    const target = edge.target = targets[0]!;
    const incoming = inbound.get(target) ?? [];
    incoming.push(edge);
    inbound.set(target, incoming);
    if (source.id === targetId) {
      add(source, 'SELF_REFERENCE', field, targetId, `${field} cannot reference its own entity ${targetId}`);
      continue;
    }
    const expected = edge.definition.target === 'self' ? source.entity.entity : edge.definition.target;
    if (expected && target.entity.entity !== expected) {
      add(source, 'REFERENCE_TYPE', field, targetId, `${field} must reference ${expected}, not ${target.entity.entity}`);
      continue;
    }
    if (edge.definition.scoped && source.entity.project !== target.entity.project)
      add(source, field === 'parent' ? 'PARENT_PROJECT_MISMATCH' : 'REFERENCE_PROJECT_MISMATCH', field, targetId, `${field} ${targetId} must belong to the same project`);
    if (field === 'parent' || field === 'blocked_by' || field === 'depends_on') {
      const graph = cycleGraphs[field];
      const outgoing = graph.get(source.id) ?? [];
      outgoing.push(targetId);
      graph.set(source.id, outgoing);
    }
  }
  for (const field of ['parent', 'blocked_by', 'depends_on'] as const) {
    const groups = components(cycleGraphs[field]);
    for (const [sourceId, targets] of cycleGraphs[field]) {
      for (const targetId of targets) {
        if (sourceId === targetId || groups.get(sourceId) !== groups.get(targetId)) continue;
        for (const source of index.ids.get(sourceId) ?? [])
          add(source, 'RELATION_CYCLE', field, targetId, `${field} cycle includes ${sourceId} and ${targetId}`);
      }
    }
  }
  // An entity with invalid relationships cannot silently remain a valid dependency target.
  for (let cursor = 0; cursor < invalidQueue.length; cursor++) {
    for (const edge of inbound.get(invalidQueue[cursor]!) ?? []) {
      if (edge.source === edge.target) continue;
      add(edge.source, 'REFERENCE_INVALID', edge.field, edge.targetId, `${edge.field} references invalid ${edge.targetId}`);
    }
  }
  for (const file of files) {
    for (const link of new Set(file.entity.links)) {
      const target = resolve(link, index).file;
      if (!target || invalid.has(target)) add(file, 'UNRESOLVED_LINK', 'links', link, `Wikilink ${link} does not resolve to a valid entity`, 'warning');
    }
  }
  return diagnostics.sort((a, b) => {
    const left = [a.path, a.entityId, a.field, a.targetId, a.code].join('\0');
    const right = [b.path, b.entityId, b.field, b.targetId, b.code].join('\0');
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
