import { z } from 'zod';
import { viewConfigOf, viewSchema, type EntityKind, type FileRecord, type ProtocolConfiguration, type ViewConfig } from './index.ts';
import { applyView } from './query.ts';
import { createReferenceResolver, normalizeWikilink, referenceEntries, type ReferenceResolution } from './relations.ts';

export interface GraphQuery {
  view?: ViewConfig;
  search?: string;
  archived?: 'exclude' | 'include' | 'only';
  centerId?: string;
  depth?: number;
  relations?: string[];
}
export interface GraphNode { id: string; title: string; entity: EntityKind; status?: string; archived: boolean; stale: boolean }
export interface GraphLink { id: string; source: string; target: string; kind: string }
export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  unresolved: { source: string; target: string; reason: 'missing' | 'ambiguous' }[];
  availableRelations: string[];
}

/** Structural HTTP contract; applyView additionally validates protocol-specific view semantics. */
export const graphQuerySchema = z.object({
  view: viewSchema.optional(),
  search: z.string().max(500).optional(),
  archived: z.enum(['exclude', 'include', 'only']).optional(),
  centerId: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).optional(),
  depth: z.number().int().min(1).max(3).optional(),
  relations: z.array(z.string().min(1).refine(value => value.trim().length > 0, 'Expected a relation kind')).max(256).optional(),
}).strict();

/**
 * Resolve against the complete workspace before applying authorization or query filters.
 * This module deliberately has no runtime/core imports, so embedded previews stay browser-safe.
 * Suppress unresolved diagnostics whenever a visibility boundary is supplied: even a reason
 * or diagnostic count could otherwise reveal the existence of an inaccessible name match.
 */
export function buildEntityGraph(files: FileRecord[], configuration: ProtocolConfiguration, query: GraphQuery = {}, options: {
  visibleIds?: ReadonlySet<string>; includeUnresolved?: boolean;
} = {}): GraphData {
  const input = graphQuerySchema.parse(query);
  const resolver = createReferenceResolver(files);
  const unique = files.filter(file => resolver.resolveId(file.id).file === file);
  const eligible = applyView(unique, input.view ? viewConfigOf(input.view) : { layout: 'graph' }, {
    configuration,
    ...(input.search === undefined ? {} : { search: input.search }),
    ...(input.archived === undefined ? {} : { archived: input.archived }),
  }).filter(file => options.visibleIds === undefined || options.visibleIds.has(file.id));
  const eligibleIds = new Set(eligible.map(file => file.id));
  if (input.centerId !== undefined && !eligibleIds.has(input.centerId)) return { nodes: [], links: [], unresolved: [], availableRelations: [] };
  const links = new Map<string, GraphLink>();
  const unresolved = new Map<string, GraphData['unresolved'][number]>();
  const includeUnresolved = options.includeUnresolved !== false && options.visibleIds === undefined;
  const selectedRelations = input.relations === undefined ? undefined : new Set(input.relations);
  const add = (source: string, target: string, kind: string, resolution: ReferenceResolution) => {
    if (resolution.file) {
      if (!eligibleIds.has(resolution.file.id)) return;
      const id = JSON.stringify([source, resolution.file.id, kind]);
      links.set(id, { id, source, target: resolution.file.id, kind });
    } else if (includeUnresolved && (selectedRelations === undefined || selectedRelations.has(kind))) {
      const issue = { source, target, reason: resolution.reason };
      unresolved.set(JSON.stringify([source, target, issue.reason]), issue);
    }
  };
  for (const file of eligible) {
    for (const { field, targetId } of referenceEntries(file.entity, configuration)) add(file.id, targetId, field, resolver.resolveId(targetId));
    const targets = new Set(file.entity.links.map(normalizeWikilink));
    for (const target of targets) if (target) add(file.id, target, 'link', resolver.resolve(target));
  }
  // Discover only edges whose endpoints survived authorization and global filters.
  // Keep this list before the requested relation subset, so deselected kinds remain selectable.
  const availableRelations = [...new Set([...links.values()].map(link => link.kind))].sort();
  const selectedLinks = [...links.values()].filter(link => selectedRelations === undefined || selectedRelations.has(link.kind));
  let selectedIds = eligibleIds;
  if (input.centerId !== undefined) {
    const neighbors = new Map<string, Set<string>>();
    for (const link of selectedLinks) {
      const outgoing = neighbors.get(link.source) ?? new Set<string>();
      outgoing.add(link.target); neighbors.set(link.source, outgoing);
      const incoming = neighbors.get(link.target) ?? new Set<string>();
      incoming.add(link.source); neighbors.set(link.target, incoming);
    }
    selectedIds = new Set([input.centerId]);
    const queue = [{ id: input.centerId, depth: 0 }];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor]!;
      if (current.depth >= (input.depth ?? 1)) continue;
      for (const id of neighbors.get(current.id) ?? []) {
        if (!selectedIds.has(id)) { selectedIds.add(id); queue.push({ id, depth: current.depth + 1 }); }
      }
    }
  }
  const nodes: GraphNode[] = eligible.filter(file => selectedIds.has(file.id)).map(file => ({
    id: file.id, title: file.entity.title, entity: file.entity.entity,
    ...(file.entity.status === undefined ? {} : { status: file.entity.status }),
    archived: file.entity.archived === true, stale: file.stale === true,
  }));
  nodes.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const resultLinks = selectedLinks.filter(link => selectedIds.has(link.source) && selectedIds.has(link.target));
  resultLinks.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const resultUnresolved = [...unresolved.entries()].filter(([, issue]) => selectedIds.has(issue.source));
  resultUnresolved.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return { nodes, links: resultLinks, unresolved: resultUnresolved.map(([, issue]) => issue), availableRelations };
}
