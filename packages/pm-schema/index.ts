import { z } from 'zod';
import { queryExpressionSchema, sortRuleSchema, type QueryExpression, type SortRule } from './query.ts';

export const entityKinds = ['project', 'work_item', 'document', 'cycle', 'milestone', 'module', 'requirement', 'release', 'goal'] as const;
export type EntityKind = typeof entityKinds[number];
export type Status = string;
export type ProjectStatus = string;
export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export type DocumentKind = 'note' | 'design' | 'decision' | 'specification';
/** Concurrent open-work points; unrelated to estimated calendar duration. */
export const MAX_WORK_ITEM_ESTIMATE_POINTS = 1_000_000;
export const MAX_WORK_ITEM_LOCATION_LENGTH = 1000;
export const entityDefinitions: Record<EntityKind, { label: string; prefix: string; directory: string }> = {
  project: { label: 'Project', prefix: 'PRJ', directory: 'projects' },
  work_item: { label: 'Work item', prefix: 'TASK', directory: 'work-items' },
  document: { label: 'Document', prefix: 'DOC', directory: 'docs' },
  cycle: { label: 'Cycle', prefix: 'CYC', directory: 'cycles' },
  milestone: { label: 'Milestone', prefix: 'MS', directory: 'milestones' },
  module: { label: 'Module', prefix: 'MOD', directory: 'modules' },
  requirement: { label: 'Requirement', prefix: 'REQ', directory: 'requirements' },
  release: { label: 'Release', prefix: 'REL', directory: 'releases' },
  goal: { label: 'Goal', prefix: 'GOAL', directory: 'goals' },
};
export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
  entityId?: string;
  field?: string;
  targetId?: string;
  line?: number;
}
export class ProtocolError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map(({ message }) => message).join('; '));
    this.name = 'ProtocolError';
    this.diagnostics = diagnostics;
  }
}
export function diagnosticsOf(error: unknown, context: { path?: string; entityId?: string } = {}): Diagnostic[] {
  if (error instanceof ProtocolError) return error.diagnostics.map((diagnostic) => ({ ...diagnostic, ...context }));
  return [{ code: 'VALIDATION_ERROR', severity: 'error', path: context.path ?? '', ...context,
    message: error instanceof Error ? error.message : String(error) }];
}

export interface WorkflowDefinition {
  initial: string;
  states: { id: string; label: string; category: 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' }[];
  transitions: { from: string; to: string }[];
  /** Preferences for category-only task commands, never additional allowed transitions. */
  default_targets?: Partial<Record<WorkflowDefinition['states'][number]['category'], string>> | undefined;
}
export interface CustomFieldDefinition {
  name: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'date' | 'select' | 'multi_select' | 'reference';
  entities: EntityKind[];
  required?: boolean;
  default?: unknown;
  options?: string[];
  target?: EntityKind;
  min?: number;
  max?: number;
}
export interface ProtocolConfiguration {
  schema: 'pm/config/v1';
  workflows: Partial<Record<EntityKind, WorkflowDefinition>>;
  custom_fields: CustomFieldDefinition[];
}
export interface ViewConfig {
  entity?: EntityKind;
  project?: string;
  layout: 'kanban' | 'table' | 'tree' | 'graph';
  group_by?: string;
  filter?: Record<string, unknown>;
  sort?: string;
  where?: QueryExpression;
  order_by?: SortRule[];
  order?: string[];
  columns?: string[];
}
export interface SavedView extends ViewConfig { id: string; name: string; revision?: string }
export interface Entity {
  [key: string]: unknown;
  schema: 'pm/v1';
  id: string;
  entity: EntityKind;
  title: string;
  kind?: 'epic' | 'task' | 'bug' | 'subtask';
  project?: string;
  parent?: string;
  status?: string;
  priority?: Priority;
  assignee?: string;
  owner?: string;
  goal?: string;
  start?: string;
  due?: string;
  estimated_duration_days?: number;
  'x-pm-start'?: string;
  'x-pm-location'?: string;
  'x-pm-estimate'?: number;
  depends_on?: string[];
  cycle?: string;
  milestone?: string;
  module?: string;
  requirement?: string;
  release?: string;
  goals?: string[];
  target?: number;
  unit?: string;
  version?: string;
  document_kind?: DocumentKind;
  archived?: boolean;
  blocked_by: string[];
  related_to: string[];
  labels: string[];
  body: string;
  links: string[];
  checklist: { text: string; checked: boolean; line: number }[];
  views: ViewConfig[];
}
export interface FileRecord {
  id: string;
  path: string;
  raw: string;
  revision: string;
  entity: Entity;
  stale?: boolean;
  error?: string;
  diagnostics?: Diagnostic[];
}
export interface UnsupportedFile {
  id?: string;
  path: string;
  raw: string;
  revision: string;
  schema?: string;
  readOnly: true;
  diagnostics: Diagnostic[];
}
export interface WorkspaceSnapshot {
  files: FileRecord[];
  errors: Diagnostic[];
  views: SavedView[];
  unsupportedFiles: UnsupportedFile[];
  configuration: ProtocolConfiguration;
  configurationRevision: string;
  configurationErrors: Diagnostic[];
}
export interface FieldDefinition {
  name: string;
  type: string;
  entities: EntityKind[];
  source: 'yaml' | 'markdown' | 'derived';
  editable: boolean;
  nullable: boolean;
  default?: unknown;
  description: string;
}
const allEntities: EntityKind[] = [...entityKinds];
const newEntities: EntityKind[] = ['cycle', 'milestone', 'module', 'requirement', 'release', 'goal'];
const workflowEntities = allEntities.filter((kind) => kind !== 'document');
const goalEntities: EntityKind[] = ['project', 'work_item', 'cycle', 'milestone', 'module', 'requirement', 'release'];
const field = (name: string, type: string, description: string, options: Partial<Omit<FieldDefinition, 'name' | 'type' | 'description'>> = {}): FieldDefinition => ({
  name, type, entities: allEntities, source: 'yaml', editable: true, nullable: true, description, ...options,
});
export const fieldRegistry: FieldDefinition[] = [
  field('schema', 'literal:pm/v1', 'Protocol version; immutable after creation.', { editable: false, nullable: false }),
  field('id', 'identifier', 'Stable identity independent of filename; immutable after creation.', { editable: false, nullable: false }),
  field('entity', `enum:${entityKinds.join('|')}`, 'Entity type; immutable after creation.', { editable: false, nullable: false }),
  field('title', 'string', 'First top-level Markdown H1 is authoritative.', { source: 'markdown', nullable: false }),
  field('archived', 'boolean', 'Hidden from default views without changing workflow state.', { default: false }),
  field('labels', 'string[]', 'Labels; an empty array clears all labels.', { default: [] }),
  field('related_to', 'identifier[]', 'References to any entity, read symmetrically.', { default: [] }),
  field('status', 'entity-specific-enum', 'State from the configured entity workflow.', { entities: workflowEntities }),
  field('owner', 'string', 'Responsible owner.', { entities: ['project', 'document', ...newEntities] }),
  field('goal', 'string', 'Project goal text, distinct from goal references.', { entities: ['project'] }),
  field('depends_on', 'identifier[]', 'Projects that must finish before this project starts; a directed same-workspace DAG independent of task blockers.', { entities: ['project'], default: [] }),
  field('start', 'date', 'Calendar date YYYY-MM-DD, no later than due.', { entities: ['project', ...newEntities.filter((kind) => kind !== 'milestone')] }),
  field('due', 'date', 'Calendar date YYYY-MM-DD.', { entities: workflowEntities }),
  field('project', 'identifier', 'Reference to a project.', { entities: allEntities.filter((kind) => kind !== 'project') }),
  field('kind', 'enum:epic|task|bug|subtask', 'Work item classification.', { entities: ['work_item'], default: 'task' }),
  field('parent', 'identifier', 'Parent of the same entity kind; work item and module parents share a project.', { entities: ['work_item', 'module', 'goal'] }),
  field('priority', 'enum:low|medium|high|urgent', 'Priority.', { entities: ['work_item', 'requirement'], default: 'medium' }),
  field('assignee', 'string', 'Work item assignee.', { entities: ['work_item'] }),
  field('blocked_by', 'identifier[]', 'Work items that block this item, including cross-project dependencies.', { entities: ['work_item'], default: [] }),
  field('estimated_duration_days', 'number', 'Explicit nonnegative finite task duration in continuous calendar days; missing means critical-path analysis is unavailable.', { entities: ['work_item'] }),
  field('x-pm-estimate', 'number', 'Explicit finite nonnegative concurrent open-work estimate points, at most 1000000; absent means unknown.', { entities: ['work_item'] }),
  field('x-pm-start', 'date', 'Work item start calendar date YYYY-MM-DD, no later than due.', { entities: ['work_item'] }),
  field('x-pm-location', 'string', 'Optional trimmed location text, at most 1000 characters; null or blank input removes it.', { entities: ['work_item'] }),
  field('document_kind', 'enum:note|design|decision|specification', 'Document classification.', { entities: ['document'], default: 'note' }),
  field('cycle', 'identifier', 'Cycle in the same project.', { entities: ['work_item'] }),
  field('milestone', 'identifier', 'Milestone in the same project.', { entities: ['work_item', 'requirement'] }),
  field('module', 'identifier', 'Module in the same project.', { entities: ['work_item', 'requirement'] }),
  field('requirement', 'identifier', 'Requirement in the same project.', { entities: ['work_item'] }),
  field('release', 'identifier', 'Release in the same project.', { entities: ['work_item', 'requirement'] }),
  field('goals', 'identifier[]', 'Goal references, which may cross projects.', { entities: goalEntities, default: [] }),
  field('target', 'number', 'Numeric goal target.', { entities: ['goal'] }),
  field('unit', 'string', 'Goal target unit.', { entities: ['goal'] }),
  field('version', 'string', 'Release version.', { entities: ['release'] }),
  field('body', 'string', 'Markdown body; change through source editing or creation.', { source: 'markdown', editable: false, nullable: false }),
  ...['links', 'checklist', 'views', 'revision', 'path', 'children', 'blocks', 'backlinks', 'progress'].map((name) =>
    field(name, ['revision', 'path'].includes(name) ? 'string' : name === 'progress' ? 'number' : 'array', 'Computed from Markdown or workspace state.', { source: 'derived', editable: false, nullable: false })),
];

const identifier = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/, 'Expected a stable ID such as TASK-102');
const entityKind = z.enum(entityKinds);
const nonempty = z.string().min(1).refine((value) => value.trim().length > 0, 'Expected nonempty text');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Expected a valid calendar date');
const stateId = nonempty;
const stateCategory = z.enum(['backlog', 'unstarted', 'started', 'completed', 'canceled']);
const workflowSchema = z.object({
  initial: stateId,
  states: z.array(z.object({ id: stateId, label: nonempty, category: stateCategory }).strict()).min(1),
  transitions: z.array(z.object({ from: stateId, to: stateId }).strict()),
  default_targets: z.partialRecord(stateCategory, stateId).optional(),
}).strict().superRefine((workflow, context) => {
  const ids = new Set<string>();
  workflow.states.forEach((state, index) => {
    if (ids.has(state.id)) context.addIssue({ code: 'custom', path: ['states', index, 'id'], message: 'Duplicate state ID' });
    ids.add(state.id);
  });
  if (!ids.has(workflow.initial)) context.addIssue({ code: 'custom', path: ['initial'], message: 'Initial state must exist' });
  const transitions = new Set<string>();
  workflow.transitions.forEach((transition, index) => {
    const key = JSON.stringify([transition.from, transition.to]);
    if (!ids.has(transition.from) || !ids.has(transition.to)) context.addIssue({ code: 'custom', path: ['transitions', index], message: 'Transition endpoints must exist' });
    if (transitions.has(key)) context.addIssue({ code: 'custom', path: ['transitions', index], message: 'Duplicate transition' });
    transitions.add(key);
  });
  for (const [category, target] of Object.entries(workflow.default_targets ?? {})) {
    if (!workflow.states.some(state => state.id === target && state.category === category))
      context.addIssue({ code: 'custom', path: ['default_targets', category], message: 'Default target must be a state in this category' });
  }
});
/** A registered extension has a single, non-coercing value schema shared with configuration validation. */
export function customFieldSchema(definition: CustomFieldDefinition): z.ZodType {
  switch (definition.type) {
    case 'text': {
      let schema = z.string();
      if (definition.min !== undefined) schema = schema.min(definition.min);
      if (definition.max !== undefined) schema = schema.max(definition.max);
      return schema;
    }
    case 'number': {
      let schema = z.number().finite();
      if (definition.min !== undefined) schema = schema.min(definition.min);
      if (definition.max !== undefined) schema = schema.max(definition.max);
      return schema;
    }
    case 'boolean': return z.boolean();
    case 'date': return date;
    case 'reference': return identifier;
    case 'select': return z.string().refine((value) => definition.options?.includes(value) === true, 'Expected a configured option');
    case 'multi_select': return z.array(z.string()).superRefine((values, context) => {
      if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: 'Duplicate selections' });
      values.forEach((value, index) => {
        if (!definition.options?.includes(value)) context.addIssue({ code: 'custom', path: [index], message: 'Expected a configured option' });
      });
      if (definition.min !== undefined && values.length < definition.min) context.addIssue({ code: 'custom', message: `Expected at least ${definition.min} selections` });
      if (definition.max !== undefined && values.length > definition.max) context.addIssue({ code: 'custom', message: `Expected at most ${definition.max} selections` });
    });
  }
}
const customDefinitionSchema = z.object({
  name: z.string().regex(/^x-.+$/), label: nonempty,
  type: z.enum(['text', 'number', 'boolean', 'date', 'select', 'multi_select', 'reference']),
  entities: z.array(entityKind).min(1), required: z.boolean().optional(), default: z.unknown().optional(),
  options: z.array(nonempty).optional(), target: entityKind.optional(), min: z.number().finite().optional(), max: z.number().finite().optional(),
}).strict().superRefine((definition, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message });
  if (new Set(definition.entities).size !== definition.entities.length) issue('entities', 'Duplicate entity applicability');
  if (fieldRegistry.some(({ name }) => name === definition.name)) issue('name', 'Built-in fields cannot be replaced');
  const selection = definition.type === 'select' || definition.type === 'multi_select';
  if (selection && !definition.options?.length) issue('options', 'Selection fields require nonempty options');
  if (!selection && definition.options !== undefined) issue('options', 'Options apply only to selection fields');
  if (definition.options && new Set(definition.options).size !== definition.options.length) issue('options', 'Duplicate options');
  if (definition.type === 'reference' && !definition.target) issue('target', 'Reference fields require a target entity kind');
  if (definition.type !== 'reference' && definition.target !== undefined) issue('target', 'Target applies only to references');
  if ((definition.min !== undefined || definition.max !== undefined) && !['number', 'text', 'multi_select'].includes(definition.type)) issue('min', 'Bounds apply only to numbers, text lengths, or selection counts');
  for (const key of ['min', 'max'] as const) {
    const bound = definition[key];
    if (bound !== undefined && definition.type !== 'number' && (!Number.isSafeInteger(bound) || bound < 0)) issue(key, 'Length/count bounds must be nonnegative integers');
  }
  if (definition.min !== undefined && definition.max !== undefined && definition.min > definition.max) issue('min', 'min must not exceed max');
  if (definition.type === 'multi_select' && definition.min !== undefined && definition.min > (definition.options?.length ?? 0)) issue('min', 'Minimum selections exceed available options');
  if (Object.hasOwn(definition, 'default')) {
    const result = customFieldSchema(materializeDefinition(definition)).safeParse(definition.default);
    if (!result.success) for (const entry of result.error.issues) context.addIssue({ code: 'custom', path: ['default', ...entry.path], message: entry.message });
  }
});
const materializeDefinition = (definition: z.infer<typeof customDefinitionSchema>): CustomFieldDefinition => ({
  name: definition.name, label: definition.label, type: definition.type, entities: definition.entities,
  ...(definition.required === undefined ? {} : { required: definition.required }),
  ...(definition.default === undefined ? {} : { default: definition.default }),
  ...(definition.options === undefined ? {} : { options: definition.options }),
  ...(definition.target === undefined ? {} : { target: definition.target }),
  ...(definition.min === undefined ? {} : { min: definition.min }),
  ...(definition.max === undefined ? {} : { max: definition.max }),
});
const configurationSchema = z.object({
  schema: z.literal('pm/config/v1'),
  workflows: z.object(Object.fromEntries(entityKinds.map((kind) => [kind, workflowSchema.optional()]))).strict().default({}),
  custom_fields: z.array(customDefinitionSchema).default([]),
}).strict().superRefine((configuration, context) => {
  if (configuration.workflows.document !== undefined) context.addIssue({ code: 'custom', path: ['workflows', 'document'], message: 'Documents do not have workflows' });
  const names = new Set<string>();
  configuration.custom_fields.forEach((definition, index) => {
    if (names.has(definition.name)) context.addIssue({ code: 'custom', path: ['custom_fields', index, 'name'], message: 'Duplicate custom field name' });
    names.add(definition.name);
  });
});
function workflow(states: [string, WorkflowDefinition['states'][number]['category']][]): WorkflowDefinition {
  return { initial: states[0]![0], states: states.map(([id, category]) => ({ id, label: id.replaceAll('_', ' '), category })),
    transitions: states.flatMap(([from]) => states.filter(([to]) => to !== from).map(([to]) => ({ from, to }))) };
}
export const defaultConfiguration: ProtocolConfiguration = {
  schema: 'pm/config/v1', custom_fields: [], workflows: {
    project: workflow([['planned', 'unstarted'], ['active', 'started'], ['on_hold', 'started'], ['completed', 'completed'], ['canceled', 'canceled']]),
    work_item: { ...workflow([['todo', 'unstarted'], ['in_progress', 'started'], ['review', 'started'], ['done', 'completed'], ['canceled', 'canceled']]),
      default_targets: { started: 'in_progress' } },
    ...Object.fromEntries(['cycle', 'milestone', 'module', 'release', 'goal'].map((kind) => [kind, workflow([['planned', 'unstarted'], ['active', 'started'], ['completed', 'completed'], ['canceled', 'canceled']])])),
    requirement: workflow([['draft', 'backlog'], ['approved', 'unstarted'], ['in_progress', 'started'], ['done', 'completed'], ['canceled', 'canceled']]),
  },
};
export function parseConfiguration(input: unknown): ProtocolConfiguration {
  const result = configurationSchema.safeParse(input);
  if (!result.success) throw new ProtocolError(result.error.issues.map((issue) => ({ code: 'CONFIGURATION_INVALID', severity: 'error', path: '.pm/config.yaml', field: issue.path.map(String).join('.'), message: issue.message })));
  const workflows = structuredClone(defaultConfiguration.workflows);
  for (const kind of workflowEntities) {
    const definition = result.data.workflows[kind];
    if (definition !== undefined) workflows[kind] = definition;
  }
  return { schema: 'pm/config/v1', workflows, custom_fields: result.data.custom_fields.map(materializeDefinition) };
}
export function workflowFor(kind: EntityKind, configuration = defaultConfiguration): WorkflowDefinition | undefined {
  return kind === 'document' ? undefined : configuration.workflows[kind] ?? defaultConfiguration.workflows[kind];
}
export function statusCategory(entity: Entity, configuration = defaultConfiguration): WorkflowDefinition['states'][number]['category'] | undefined {
  return workflowFor(entity.entity, configuration)?.states.find(({ id }) => id === entity.status)?.category;
}
export function validateTransition(before: Entity, after: Entity, configuration = defaultConfiguration): Diagnostic[] {
  if (before.status === after.status || before.entity !== after.entity) return [];
  const definition = workflowFor(after.entity, configuration);
  if (!definition || definition.transitions.some(({ from, to }) => from === before.status && to === after.status)) return [];
  return [{ code: 'TRANSITION_NOT_ALLOWED', severity: 'error', path: '', entityId: after.id, field: 'status', message: `Transition ${String(before.status)} → ${String(after.status)} is not allowed for ${after.entity}` }];
}
// Inspect raw keys before Zod's record projection can discard prototype-sensitive names.
const compactFilterSchema = z.unknown().superRefine((value, context) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    context.addIssue({ code: 'custom', message: 'Filter must be a plain object' });
    return;
  }
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype')
      context.addIssue({ code: 'custom', path: [key], message: `Unsafe filter field: ${key}` });
  }
}).pipe(z.record(z.string(), z.unknown()));
export const viewSchema = z.object({
  entity: entityKind.optional(), project: identifier.optional(), layout: z.enum(['kanban', 'table', 'tree', 'graph']),
  group_by: nonempty.optional(), filter: compactFilterSchema.optional(), sort: nonempty.optional(),
  where: z.lazy(() => queryExpressionSchema).optional(), order_by: z.array(z.lazy(() => sortRuleSchema)).optional(),
  order: z.array(identifier).refine((values) => new Set(values).size === values.length, 'Duplicate manual order IDs').optional(),
  columns: z.array(nonempty).refine((values) => new Set(values).size === values.length, 'Duplicate columns').optional(),
}).strict();
/** Normalize a parsed view into the public shape, omitting absent optional keys. */
export function viewConfigOf(view: z.infer<typeof viewSchema>): ViewConfig {
  return {
    layout: view.layout,
    ...(view.entity === undefined ? {} : { entity: view.entity }),
    ...(view.project === undefined ? {} : { project: view.project }),
    ...(view.group_by === undefined ? {} : { group_by: view.group_by }),
    ...(view.filter === undefined ? {} : { filter: view.filter }),
    ...(view.sort === undefined ? {} : { sort: view.sort }),
    ...(view.where === undefined ? {} : { where: view.where }),
    ...(view.order_by === undefined ? {} : { order_by: view.order_by }),
    ...(view.order === undefined ? {} : { order: view.order }),
    ...(view.columns === undefined ? {} : { columns: view.columns }),
  };
}
const entityObject = z.object({
  schema: z.literal('pm/v1'), id: identifier, entity: entityKind, title: nonempty,
  archived: z.boolean().default(false), related_to: z.array(identifier).default([]), labels: z.array(nonempty).default([]),
  body: z.string(), links: z.array(z.string()).default([]),
  checklist: z.array(z.object({ text: z.string(), checked: z.boolean(), line: z.number().int().positive() })).default([]),
  views: z.array(viewSchema).default([]), blocked_by: z.array(identifier).default([]),
  status: nonempty.optional(), kind: z.enum(['epic', 'task', 'bug', 'subtask']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(), document_kind: z.enum(['note', 'design', 'decision', 'specification']).optional(),
  project: identifier.optional(), parent: identifier.optional(), owner: nonempty.optional(), assignee: nonempty.optional(), goal: nonempty.optional(),
  start: date.optional(), due: date.optional(), cycle: identifier.optional(), milestone: identifier.optional(), module: identifier.optional(),
  requirement: identifier.optional(), release: identifier.optional(), goals: z.array(identifier).optional(),
  depends_on: z.array(identifier).refine((values) => new Set(values).size === values.length, 'Duplicate project dependency').optional(),
  estimated_duration_days: z.number().finite().nonnegative().optional(),
  'x-pm-estimate': z.number().finite().nonnegative().max(MAX_WORK_ITEM_ESTIMATE_POINTS).optional(),
  'x-pm-start': date.optional(),
  'x-pm-location': z.string().min(1).max(MAX_WORK_ITEM_LOCATION_LENGTH).refine(value => value === value.trim(), 'Location must be trimmed').optional(),
  target: z.number().finite().optional(), unit: nonempty.optional(), version: nonempty.optional(),
}).passthrough();
/** Configuration is supplied by the workspace; source metadata is never coerced or normalized. */
export function entitySchemaFor(configuration: ProtocolConfiguration = defaultConfiguration) {
  return entityObject.transform((value): Entity => {
    const entity = value as Entity;
    const definition = workflowFor(entity.entity, configuration);
    if (definition && entity.status === undefined) entity.status = definition.initial;
    if (entity.entity === 'work_item') entity.kind ??= 'task';
    if (entity.entity === 'project') entity.depends_on ??= [];
    if (entity.entity === 'work_item' || entity.entity === 'requirement') entity.priority ??= 'medium';
    if (entity.entity === 'document') entity.document_kind ??= 'note';
    if (goalEntities.includes(entity.entity)) entity.goals ??= [];
    for (const custom of configuration.custom_fields) {
      if (custom.entities.includes(entity.entity) && entity[custom.name] === undefined && Object.hasOwn(custom, 'default')) entity[custom.name] = structuredClone(custom.default);
    }
    return entity;
  }).superRefine((entity, context) => {
    for (const definition of fieldRegistry) {
      if (definition.source !== 'yaml' || definition.entities.includes(entity.entity) || entity[definition.name] === undefined) continue;
      // blocked_by is an empty derived convenience on entities that do not support persisted blockers.
      if (definition.name === 'blocked_by' && entity.blocked_by.length === 0) continue;
      context.addIssue({ code: 'custom', path: [definition.name], message: `${definition.name} is not applicable to ${entity.entity}` });
    }
    const definition = workflowFor(entity.entity, configuration);
    if (definition && !definition.states.some(({ id }) => id === entity.status)) context.addIssue({ code: 'custom', path: ['status'], message: 'Expected a configured workflow state' });
    if (entity.start && entity.due && entity.start > entity.due) context.addIssue({ code: 'custom', path: ['start'], message: 'start must not be later than due' });
    if (entity['x-pm-start'] && entity.due && entity['x-pm-start'] > entity.due) context.addIssue({ code: 'custom', path: ['x-pm-start'], message: 'x-pm-start must not be later than due' });
    for (const custom of configuration.custom_fields) {
      const value = entity[custom.name];
      if (!custom.entities.includes(entity.entity)) {
        if (value !== undefined) context.addIssue({ code: 'custom', path: [custom.name], message: `${custom.name} is not applicable to ${entity.entity}` });
      } else if (value === undefined && !custom.required) continue;
      else {
        const result = customFieldSchema(custom).safeParse(value);
        if (!result.success) for (const issue of result.error.issues) context.addIssue({ code: 'custom', path: [custom.name, ...issue.path], message: issue.message });
      }
    }
  });
}
export const entitySchema = entitySchemaFor();
export const projectSchema = entitySchema.refine((entity) => entity.entity === 'project', { path: ['entity'], message: 'Expected project' });
export const workItemSchema = entitySchema.refine((entity) => entity.entity === 'work_item', { path: ['entity'], message: 'Expected work_item' });
export const documentSchema = entitySchema.refine((entity) => entity.entity === 'document', { path: ['entity'], message: 'Expected document' });
export const cycleSchema = entitySchema.refine((entity) => entity.entity === 'cycle', { path: ['entity'], message: 'Expected cycle' });
export const milestoneSchema = entitySchema.refine((entity) => entity.entity === 'milestone', { path: ['entity'], message: 'Expected milestone' });
export const moduleSchema = entitySchema.refine((entity) => entity.entity === 'module', { path: ['entity'], message: 'Expected module' });
export const requirementSchema = entitySchema.refine((entity) => entity.entity === 'requirement', { path: ['entity'], message: 'Expected requirement' });
export const releaseSchema = entitySchema.refine((entity) => entity.entity === 'release', { path: ['entity'], message: 'Expected release' });
export const goalSchema = entitySchema.refine((entity) => entity.entity === 'goal', { path: ['entity'], message: 'Expected goal' });
export const protocolInfo = {
  schema: 'pm/v1', entities: allEntities, entityDefinitions, fields: fieldRegistry,
  statuses: Object.fromEntries(workflowEntities.map((kind) => [kind, workflowFor(kind)!.states.map(({ id }) => id)])),
  documentKinds: ['note', 'design', 'decision', 'specification'], extensionPrefix: 'x-',
};
