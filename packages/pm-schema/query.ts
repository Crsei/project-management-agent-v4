import { z } from 'zod';
import {
  customFieldSchema, defaultConfiguration, entityKinds, fieldRegistry, ProtocolError, validateTransition, viewConfigOf, viewSchema, workflowFor,
  type CustomFieldDefinition, type Entity, type EntityKind, type FileRecord, type ProtocolConfiguration, type ViewConfig,
} from './index.ts';

export type QueryExpression =
  | { all: QueryExpression[] }
  | { any: QueryExpression[] }
  | { not: QueryExpression }
  | { field: string; op: 'eq' | 'ne' | 'in' | 'not_in' | 'contains' | 'exists' | 'gt' | 'gte' | 'lt' | 'lte'; value?: unknown };
export interface SortRule { field: string; direction: 'asc' | 'desc' }

const MAX_DEPTH = 16;
const MAX_NODES = 256;
const MAX_VALUES = 256;
const operators = ['eq', 'ne', 'in', 'not_in', 'contains', 'exists', 'gt', 'gte', 'lt', 'lte'];
const identifier = /^[A-Z][A-Z0-9]*-\d+$/;
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function scalar(value: unknown): boolean {
  return value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.length <= 8192);
}
function boundedValue(value: unknown): boolean {
  return scalar(value) || (Array.isArray(value) && value.length <= MAX_VALUES && value.every(scalar));
}
/** Inspect before descending: recursive Zod schemas overflow before their refinements can run. */
function expressionProblem(input: unknown): string | undefined {
  const pending = [{ value: input, depth: 1 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return `Queries are limited to ${MAX_NODES} nodes and depth ${MAX_DEPTH}`;
    if (!object(value)) return 'Each query expression must be an object';
    const keys = Object.keys(value);
    if (own(value, 'all') || own(value, 'any')) {
      const key = own(value, 'all') ? 'all' : 'any';
      const children = value[key];
      if (keys.length !== 1 || !Array.isArray(children) || children.length > MAX_NODES) return `${key} requires an array of expressions`;
      for (const child of children) pending.push({ value: child, depth: depth + 1 });
    } else if (own(value, 'not')) {
      if (keys.length !== 1) return 'not accepts only one expression';
      pending.push({ value: value.not, depth: depth + 1 });
    } else {
      if (keys.some((key) => !['field', 'op', 'value'].includes(key)) || typeof value.field !== 'string'
        || !value.field.trim() || value.field.length > 128 || typeof value.op !== 'string' || !operators.includes(value.op)) return 'Invalid query field or operator';
      if (value.op === 'exists') {
        if (own(value, 'value') && typeof value.value !== 'boolean') return 'exists accepts an optional boolean';
      } else if (!own(value, 'value') || !boundedValue(value.value)) return 'Query values must be finite JSON scalars or bounded scalar arrays';
    }
  }
}
export const queryExpressionSchema = z.unknown().superRefine((value, context) => {
  const problem = expressionProblem(value);
  if (problem) context.addIssue({ code: 'custom', message: problem });
}).transform((value): QueryExpression => value as QueryExpression);
export const sortRuleSchema = z.object({ field: z.string().trim().min(1).max(128), direction: z.enum(['asc', 'desc']) }).strict();

type ValueType = 'string' | 'number' | 'boolean' | 'date' | 'timestamp' | 'identifier';
interface QueryField {
  name: string;
  type: ValueType;
  array: boolean;
  entities: EntityKind[];
  nullable: boolean;
  editable: boolean;
  defaulted: boolean;
  options?: string[];
  custom?: CustomFieldDefinition;
}
function fail(message: string, field?: string): never {
  throw new ProtocolError([{ code: 'INVALID_VIEW', severity: 'error', path: '', message, ...(field ? { field } : {}) }]);
}
function resolveField(name: string, kind: EntityKind | undefined, configuration: ProtocolConfiguration): QueryField {
  const builtin = fieldRegistry.find((definition) => definition.name === name);
  const custom = configuration.custom_fields.find((definition) => definition.name === name);
  if (!builtin && !custom) fail(`Unknown query field: ${name}`, name);
  if (builtin && custom) fail(`Ambiguous query field: ${name}`, name);
  if (builtin?.source === 'derived') fail(`Derived field cannot be queried: ${name}`, name);
  const entities = (builtin ?? custom)!.entities;
  if (kind && !entities.includes(kind)) fail(`${name} does not apply to ${kind}`, name);
  let type: ValueType = 'string';
  let array = false;
  let options: string[] | undefined;
  if (custom) {
    type = custom.type === 'reference' ? 'identifier' : ['number', 'boolean', 'date'].includes(custom.type) ? custom.type as ValueType : 'string';
    array = custom.type === 'multi_select';
    options = custom.options;
  } else {
    const declared = builtin!.type;
    array = declared.endsWith('[]');
    const base = array ? declared.slice(0, -2) : declared;
    if (['number', 'boolean', 'date', 'timestamp', 'identifier'].includes(base)) type = base as ValueType;
    else if (base.startsWith('enum:')) options = base.slice(5).split('|');
    else if (base.startsWith('literal:')) options = [base.slice(8)];
    else if (base === 'entity-specific-enum') {
      options = [...new Set((kind ? [kind] : entities).flatMap((entity) => workflowFor(entity, configuration)?.states.map((state) => state.id) ?? []))];
    } else if (base !== 'string') fail(`Field has no unambiguous scalar query type: ${name}`, name);
  }
  return { name, type, array, entities, ...(options === undefined ? {} : { options }), ...(custom === undefined ? {} : { custom }), nullable: custom ? !custom.required : builtin!.nullable,
    editable: custom ? true : builtin!.editable, defaulted: custom ? own(custom, 'default') : name === 'status' || own(builtin!, 'default') };
}
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}
function checkScalar(field: QueryField, value: unknown): void {
  if (value === null || value === undefined) fail(`${field.name} requires a ${field.type} value`, field.name);
  const type = field.type === 'date' || field.type === 'timestamp' || field.type === 'identifier' ? 'string' : field.type;
  if (typeof value !== type || !scalar(value)) fail(`${field.name} requires a ${field.type} value without coercion`, field.name);
  if (field.type === 'date' && !validDate(value as string)) fail(`${field.name} requires a valid YYYY-MM-DD date`, field.name);
  if (field.type === 'timestamp' && !validTimestamp(value as string)) fail(`${field.name} requires a valid ISO timestamp`, field.name);
  if (field.type === 'identifier' && !identifier.test(value as string)) fail(`${field.name} requires a stable identifier`, field.name);
  if (field.options && !field.options.includes(value as string)) fail(`Unsupported value for ${field.name}: ${String(value)}`, field.name);
}
function checkPredicate(expression: Extract<QueryExpression, { field: string }>, field: QueryField): void {
  const { op, value } = expression;
  if (op === 'exists') return;
  if (op === 'eq' || op === 'ne') {
    if (value === null) {
      if (!field.nullable) fail(`${field.name} cannot be missing`, field.name);
      return;
    }
    if (field.array) {
      if (!Array.isArray(value)) fail(`${field.name} equality requires an array; use contains for membership`, field.name);
      value.forEach((entry) => checkScalar(field, entry));
    } else checkScalar(field, value);
    return;
  }
  if (op === 'in' || op === 'not_in') {
    if (field.array || !Array.isArray(value)) fail(`${op} requires a scalar field and an array of values`, field.name);
    value.forEach((entry) => checkScalar(field, entry));
    return;
  }
  if (op === 'contains') {
    if (!field.array && (field.type !== 'string' || field.options)) fail(`contains requires a text or array field`, field.name);
    checkScalar(field, value);
    return;
  }
  if (field.array || !['number', 'date', 'timestamp'].includes(field.type)) fail(`${op} requires a numeric or date field`, field.name);
  checkScalar(field, value);
}
function compactExpression(field: QueryField, value: unknown): Extract<QueryExpression, { field: string }> {
  return { field: field.name, op: field.array && !Array.isArray(value) && value !== null ? 'contains' : 'eq', value };
}
/** Ordered AND conditions; values in one condition are OR. */
export type CompactFilterCondition = {
  field: string;
  operator: 'is' | 'isNot';
  values: readonly unknown[];
};
/**
 * Compile UI filter rows into the same bounded DSL used by `ViewConfig.where`.
 * Scalar fields use `in`; array fields (e.g. labels) use `contains` per value.
 * `isNot` is a negation, so missing values also match, matching the row semantics.
 */
export function filterConditionsExpression(
  conditions: readonly CompactFilterCondition[],
  options: { entity?: EntityKind; configuration?: ProtocolConfiguration } = {},
): QueryExpression | undefined {
  const configuration = options.configuration ?? defaultConfiguration;
  const expressions: QueryExpression[] = [];
  for (const condition of conditions) {
    const values = condition.values.filter((value) => value !== undefined && value !== null && value !== '');
    if (!values.length) continue;
    const field = resolveField(condition.field, options.entity, configuration);
    if (field.array) {
      const any: QueryExpression = { any: values.map((value) => {
        const expression = { field: field.name, op: 'contains' as const, value };
        checkPredicate(expression, field);
        return expression;
      }) };
      expressions.push(condition.operator === 'isNot' ? { not: any } : any);
    } else {
      const expression = { field: field.name, op: 'in' as const, value: values };
      checkPredicate(expression, field);
      expressions.push(condition.operator === 'isNot' ? { not: expression } : expression);
    }
  }
  if (!expressions.length) return undefined;
  return expressions.length === 1 ? expressions[0] : { all: expressions };
}
function checkGrouping(field: QueryField): void {
  if (!field.editable || field.array) fail(`Grouping requires a single editable scalar field: ${field.name}`, field.name);
}

/** Validate field applicability and operands in addition to the bounded structural DSL. */
export function validateView(config: ViewConfig, configuration: ProtocolConfiguration = defaultConfiguration): ViewConfig {
  if (!object(config)) fail('View must be an object');
  const allowed = ['entity', 'project', 'layout', 'group_by', 'filter', 'sort', 'where', 'order_by', 'order', 'columns', 'id', 'name', 'revision'];
  for (const key of Object.keys(config)) if (!allowed.includes(key)) fail(`Unknown view option: ${key}`, key);
  // Inspect original keys before Zod record parsing can normalize them away.
  if (config.filter !== undefined) {
    if (!object(config.filter)) fail('Compact filters must be an object', 'filter');
    if (Object.keys(config.filter).length > 128) fail('At most 128 compact filters are allowed');
    for (const name of Object.keys(config.filter)) resolveField(name, config.entity, configuration);
  }
  const input: Record<string, unknown> = { ...config };
  delete input.id;
  delete input.name;
  delete input.revision;
  const parsed = viewSchema.safeParse(input);
  if (!parsed.success) throw new ProtocolError(parsed.error.issues.map((issue) => ({ code: 'INVALID_VIEW', severity: 'error' as const,
    path: issue.path.join('.'), field: String(issue.path[0] ?? ''), message: issue.message })));
  const view: ViewConfig = viewConfigOf(parsed.data);
  const resolve = (name: string) => resolveField(name, view.entity, configuration);
  if (view.filter) {
    if (Object.keys(view.filter).length > 128) fail('At most 128 compact filters are allowed');
    for (const [name, value] of Object.entries(view.filter)) {
      if (!boundedValue(value)) fail('Filter values must be finite JSON scalars or bounded scalar arrays', name);
      const field = resolve(name);
      checkPredicate(compactExpression(field, value), field);
    }
  }
  if (view.where) {
    const pending = [view.where];
    while (pending.length) {
      const expression = pending.pop()!;
      if ('all' in expression) pending.push(...expression.all);
      else if ('any' in expression) pending.push(...expression.any);
      else if ('not' in expression) pending.push(expression.not);
      else checkPredicate(expression, resolve(expression.field));
    }
  }
  if ((view.order_by?.length ?? 0) > 32) fail('At most 32 sort rules are allowed');
  const seenSorts = new Set<string>();
  for (const rule of view.order_by ?? []) {
    if (seenSorts.has(rule.field)) fail(`Duplicate sort field: ${rule.field}`, rule.field);
    seenSorts.add(rule.field);
    if (resolve(rule.field).array) fail('Array fields cannot be sorted', rule.field);
  }
  if (view.sort && resolve(view.sort).array) fail('Array fields cannot be sorted', view.sort);
  if (view.group_by) checkGrouping(resolve(view.group_by));
  if (view.columns) {
    if (view.columns.length > 128 || new Set(view.columns).size !== view.columns.length) fail('Columns must be unique, with at most 128 entries');
    view.columns.forEach(resolve);
  }
  if (view.order) {
    if (view.order.length > 10000 || new Set(view.order).size !== view.order.length || view.order.some((id) => !identifier.test(id))) fail('Manual order requires unique stable IDs, with at most 10000 entries');
  }
  return view;
}

function fieldValue(entity: Entity, field: QueryField): unknown {
  // Ignore retained legacy metadata on kinds to which the registered field does not apply.
  return field.entities.includes(entity.entity) && own(entity, field.name) ? entity[field.name] : undefined;
}
function equal(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((value, index) => value === right[index]) : left === right;
}
function predicate(entity: Entity, expression: Extract<QueryExpression, { field: string }>, field: QueryField): boolean {
  const actual = fieldValue(entity, field);
  const missing = actual === undefined || actual === null;
  const expected = expression.value;
  if (expression.op === 'exists') return missing === (expected === false);
  if ((expression.op === 'eq' || expression.op === 'ne') && expected === null) return expression.op === 'eq' ? missing : !missing;
  if (missing) return false;
  switch (expression.op) {
    case 'eq': return equal(actual, expected);
    case 'ne': return !equal(actual, expected);
    case 'in': return (expected as unknown[]).some((value) => equal(actual, value));
    case 'not_in': return !(expected as unknown[]).some((value) => equal(actual, value));
    case 'contains': return Array.isArray(actual) ? actual.some((value) => value === expected)
      : typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    case 'gt': case 'gte': case 'lt': case 'lte': {
      let comparison: number;
      if (typeof actual === 'number' && typeof expected === 'number') comparison = actual - expected;
      else if (typeof actual === 'string' && typeof expected === 'string') comparison = lexical(actual, expected);
      else return false;
      return expression.op === 'gt' ? comparison > 0 : expression.op === 'gte' ? comparison >= 0
        : expression.op === 'lt' ? comparison < 0 : comparison <= 0;
    }
  }
}
function compile(expression: QueryExpression, resolve: (name: string) => QueryField): (entity: Entity) => boolean {
  if ('all' in expression) { const children = expression.all.map((child) => compile(child, resolve)); return (entity) => children.every((child) => child(entity)); }
  if ('any' in expression) { const children = expression.any.map((child) => compile(child, resolve)); return (entity) => children.some((child) => child(entity)); }
  if ('not' in expression) { const child = compile(expression.not, resolve); return (entity) => !child(entity); }
  const field = resolve(expression.field);
  return (entity) => predicate(entity, expression, field);
}
function lexical(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sortableValue(entity: Entity, field: QueryField, configuration: ProtocolConfiguration): unknown {
  const value = fieldValue(entity, field);
  if (value === undefined || value === null) return undefined;
  if (field.name === 'priority') return ['urgent', 'high', 'medium', 'low'].indexOf(value as string);
  if (field.name === 'status') return workflowFor(entity.entity, configuration)?.states.findIndex((state) => state.id === value);
  return value;
}
function compare(left: unknown, right: unknown, direction: SortRule['direction']): number {
  // Missing values sort last in either direction; JSON primitives never coerce each other.
  if (left === undefined || left === null) return right === undefined || right === null ? 0 : 1;
  if (right === undefined || right === null) return -1;
  let result = 0;
  if (typeof left === 'number' && typeof right === 'number') result = left - right;
  else if (typeof left === 'boolean' && typeof right === 'boolean') result = Number(left) - Number(right);
  else if (typeof left === 'string' && typeof right === 'string') result = lexical(left, right);
  else result = lexical(typeof left, typeof right);
  return direction === 'desc' ? -result : result;
}

export function applyView(files: FileRecord[], config: ViewConfig, options: {
  configuration?: ProtocolConfiguration; search?: string; archived?: 'exclude' | 'include' | 'only';
} = {}): FileRecord[] {
  const configuration = options.configuration ?? defaultConfiguration;
  const view = validateView(config, configuration);
  const archived = options.archived ?? 'exclude';
  if (!['exclude', 'include', 'only'].includes(archived)) fail('Invalid archive mode');
  const fields = new Map<string, QueryField>();
  const resolve = (name: string) => {
    let field = fields.get(name);
    if (!field) { field = resolveField(name, view.entity, configuration); fields.set(name, field); }
    return field;
  };
  const predicates = Object.entries(view.filter ?? {}).map(([name, value]) => compile(compactExpression(resolve(name), value), resolve));
  if (view.where) predicates.push(compile(view.where, resolve));
  const rules = [...view.order_by ?? []];
  if (view.sort && !rules.some((rule) => rule.field === view.sort)) rules.push({ field: view.sort, direction: 'asc' });
  const sorts = rules.map((rule) => ({ ...rule, definition: resolve(rule.field) }));
  const ranks = new Map((view.order ?? []).map((id, index) => [id, index]));
  const search = options.search?.toLowerCase() ?? '';
  return files.filter(({ entity }) => (!view.entity || entity.entity === view.entity)
    && (!view.project || entity.project === view.project || entity.id === view.project)
    && (archived === 'include' || (archived === 'only' ? entity.archived === true : entity.archived !== true))
    && predicates.every((matches) => matches(entity))
    && (!search || `${entity.id} ${entity.title} ${entity.labels.join(' ')}`.toLowerCase().includes(search)))
    .sort((left, right) => {
      const leftRank = ranks.get(left.id), rightRank = ranks.get(right.id);
      if (leftRank !== undefined || rightRank !== undefined) {
        const order = (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER);
        if (order) return order;
      }
      for (const rule of sorts) {
        const order = compare(sortableValue(left.entity, rule.definition, configuration), sortableValue(right.entity, rule.definition, configuration), rule.direction);
        if (order) return order;
      }
      return lexical(left.id, right.id);
    });
}

/** Return a validated patch, never mutate the entity. References are resolved by the workspace write. */
export function groupChange(entity: Entity, name: string, value: unknown, configuration: ProtocolConfiguration = defaultConfiguration): Record<string, unknown> {
  if (!entityKinds.includes(entity.entity)) fail('Unknown entity kind');
  if (entity.schema !== 'pm/v1') fail('Unknown protocol versions are read-only');
  const field = resolveField(name, entity.entity, configuration);
  checkGrouping(field);
  if (value === null) {
    if (!field.nullable || field.defaulted) fail(`${name} cannot be an ungrouped field`, name);
  } else {
    checkScalar(field, value);
    if (name === 'estimated_duration_days' && (value as number) < 0) fail('estimated_duration_days must be nonnegative', name);
    if (typeof value === 'string' && !value.trim()) fail(`${name} cannot be empty`, name);
    if (name === 'title' && typeof value === 'string' && /[\r\n]/.test(value)) fail('title must be a single line', name);
    if (field.custom) {
      const parsed = customFieldSchema(field.custom).safeParse(value);
      if (!parsed.success) fail(parsed.error.issues.map((issue) => issue.message).join('; '), name);
    }
  }
  const next = { ...entity };
  if (value === null) delete next[name]; else next[name] = value;
  if (typeof next.start === 'string' && typeof next.due === 'string' && next.start > next.due) fail('start must not be later than due', name);
  const diagnostics = validateTransition(entity, next, configuration);
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) throw new ProtocolError(diagnostics);
  return { [name]: value };
}
