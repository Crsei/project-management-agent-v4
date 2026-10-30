import { workflowFor, type FileRecord, type ProtocolConfiguration, type ViewConfig } from '@pm-schema';
import type { QueryExpression } from '@pm-schema/query';
import { filterConditionsExpression } from '@pm-schema/query';
import { priorities } from '@pm-views';
import { taskStateLabel } from './task-status-label';

export type TaskFilterField = 'status' | 'assignee' | 'priority' | 'due' | 'project' | 'labels' | 'created' | 'updated';
export type TaskFilterOperator = 'is' | 'isNot';
export interface TaskFilterCondition { field: TaskFilterField; operator: TaskFilterOperator; values: string[] }
export interface TaskFilterOption { value: string; label: string }

export const taskFilterFields: readonly TaskFilterField[] = ['status', 'assignee', 'priority', 'due', 'project', 'labels', 'created', 'updated'];
export const priorityLabels: Record<string, string> = { urgent: '紧急', high: '高', medium: '中', low: '低' };
const dueBuckets = ['overdue', 'today', 'week', 'later', 'none'] as const;
const timestampBuckets = ['24h', '7d', '30d'] as const;

export function taskFilterFieldLabel(field: TaskFilterField, en: boolean) {
  return {
    status: en ? 'Status' : '状态',
    assignee: en ? 'Assignee' : '负责人',
    priority: en ? 'Priority' : '优先级',
    due: en ? 'Due date' : '截止日期',
    project: en ? 'Project' : '项目',
    labels: en ? 'Labels' : '标签',
    created: en ? 'Created date' : '创建日期',
    updated: en ? 'Updated date' : '更新日期',
  }[field];
}

export function taskFilterOperatorLabel(operator: TaskFilterOperator, en: boolean) {
  return operator === 'isNot' ? (en ? 'is not' : '不是') : (en ? 'is' : '是');
}

export function taskFilterOptions(
  field: TaskFilterField,
  input: { en: boolean; configuration: ProtocolConfiguration; files: readonly FileRecord[]; actors?: readonly { id: string; name: string }[]; projects?: readonly { id: string; title: string }[] },
): TaskFilterOption[] {
  const workItems = input.files.filter(file => file.entity.entity === 'work_item');
  if (field === 'status')
    return (workflowFor('work_item', input.configuration)?.states ?? []).map(state => ({ value: state.id, label: taskStateLabel(state, input.en) }));
  if (field === 'priority') return priorities.map(priority => ({ value: priority, label: input.en ? priority : priorityLabels[priority] ?? priority }));
  if (field === 'assignee')
    return [...new Set(workItems.map(file => file.entity.assignee).filter((value): value is string => typeof value === 'string' && value.length > 0))]
      .sort((left, right) => left.localeCompare(right))
      .map(value => ({ value, label: input.actors?.find(actor => actor.id === value)?.name ?? value }));
  if (field === 'project') return (input.projects ?? []).map(project => ({ value: project.id, label: project.title }));
  if (field === 'labels')
    return [...new Set(workItems.flatMap(file => file.entity.labels))].sort((left, right) => left.localeCompare(right)).map(value => ({ value, label: value }));
  if (field === 'created' || field === 'updated')
    return timestampBuckets.map(value => ({ value, label: {
      '24h': input.en ? 'Last 24 hours' : '最近 24 小时',
      '7d': input.en ? 'Last 7 days' : '最近 7 天',
      '30d': input.en ? 'Last 30 days' : '最近 30 天',
    }[value] }));
  return dueBuckets.map(value => ({ value, label: {
    overdue: input.en ? 'Overdue' : '已逾期',
    today: input.en ? 'Today' : '今天',
    week: input.en ? 'Next 7 days' : '未来 7 天',
    later: input.en ? 'Later' : '更晚',
    none: input.en ? 'No due date' : '无截止日期',
  }[value] }));
}

export function taskFilterValueLabel(field: TaskFilterField, value: string, options: readonly TaskFilterOption[]) {
  return options.find(option => option.value === value)?.label ?? value;
}

export function taskFilterValueSummary(field: TaskFilterField, values: readonly string[], options: readonly TaskFilterOption[], en: boolean) {
  if (!values.length) return en ? 'Any' : '任意';
  if (values.length > 2) return en ? `${values.length} selected` : `已选 ${values.length} 项`;
  return values.map(value => taskFilterValueLabel(field, value, options)).join(', ');
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dueBucketExpression(bucket: string, today: string, configuration: ProtocolConfiguration): QueryExpression | undefined {
  if (bucket === 'overdue') {
    const terminal = (workflowFor('work_item', configuration)?.states ?? [])
      .filter(state => state.category === 'completed' || state.category === 'canceled')
      .map(state => state.id);
    return {
      all: [
        { field: 'due', op: 'lt', value: today },
        ...(terminal.length ? [{ field: 'status', op: 'not_in' as const, value: terminal }] : []),
      ],
    };
  }
  if (bucket === 'today') return { field: 'due', op: 'eq', value: today };
  if (bucket === 'week') return { all: [{ field: 'due', op: 'gte', value: today }, { field: 'due', op: 'lte', value: addDays(today, 7) }] };
  if (bucket === 'later') return { field: 'due', op: 'gt', value: addDays(today, 7) };
  if (bucket === 'none') return { field: 'due', op: 'exists', value: false };
  return undefined;
}

/** Task filter rows compiled to the bounded query DSL. Rows are AND; values in a row are OR. */
export function taskFilterWhere(
  conditions: readonly TaskFilterCondition[],
  input: { today: string | null; configuration: ProtocolConfiguration },
): QueryExpression | undefined {
  const scalar = filterConditionsExpression(
    conditions.filter(condition => !['due', 'created', 'updated'].includes(condition.field)),
    { entity: 'work_item', configuration: input.configuration },
  );
  const due: QueryExpression[] = [];
  if (input.today)
    for (const condition of conditions) {
      if (condition.field !== 'due') continue;
      const buckets = condition.values.map(value => dueBucketExpression(value, input.today!, input.configuration)).filter((value): value is QueryExpression => !!value);
      if (!buckets.length) continue;
      const any: QueryExpression = buckets.length === 1 ? buckets[0] : { any: buckets };
      due.push(condition.operator === 'isNot' ? { not: any } : any);
    }
  const timestamp: QueryExpression[] = [];
  for (const condition of conditions) {
    if (condition.field !== 'created' && condition.field !== 'updated') continue;
    const field = condition.field === 'created' ? 'x-pm-created-at' : 'x-pm-updated-at';
    const windows: Record<string, number> = { '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000, '30d': 30 * 24 * 60 * 60 * 1000 };
    const expressions: QueryExpression[] = condition.values.flatMap(value => {
      const span = windows[value];
      return span ? [{ field, op: 'gte' as const, value: new Date(Date.now() - span).toISOString() }] : [];
    });
    if (!expressions.length) continue;
    const any: QueryExpression = expressions.length === 1 ? expressions[0] : { any: expressions };
    timestamp.push(condition.operator === 'isNot' ? { not: any } : any);
  }
  const expressions = [scalar, ...due, ...timestamp].filter((value): value is QueryExpression => !!value);
  if (!expressions.length) return undefined;
  return expressions.length === 1 ? expressions[0] : { all: expressions };
}

function parseCondition(expression: QueryExpression): TaskFilterCondition | undefined {
  if ('not' in expression) {
    const inner = parseCondition(expression.not);
    return inner ? { ...inner, operator: inner.operator === 'is' ? 'isNot' : 'is' } : undefined;
  }
  if ('any' in expression) {
    const values: string[] = [];
    let field: TaskFilterCondition['field'] | undefined;
    for (const child of expression.any) {
      if (!('field' in child) || child.op !== 'contains' || typeof child.value !== 'string') return undefined;
      if (!taskFilterFields.includes(child.field as TaskFilterCondition['field'])) return undefined;
      if (field && field !== child.field) return undefined;
      field = child.field as TaskFilterCondition['field'];
      values.push(child.value);
    }
    return field && values.length ? { field, operator: 'is', values } : undefined;
  }
  if ('field' in expression && expression.op === 'in' && Array.isArray(expression.value)) {
    const values = expression.value;
    if (!values.length || !values.every((value): value is string => typeof value === 'string') || !taskFilterFields.includes(expression.field as TaskFilterCondition['field'])) return undefined;
    return { field: expression.field as TaskFilterCondition['field'], operator: 'is', values };
  }
  return undefined;
}

function splitWhere(where: QueryExpression): { conditions: TaskFilterCondition[]; residual?: QueryExpression } {
  if ('all' in where) {
    const conditions: TaskFilterCondition[] = [];
    const residual: QueryExpression[] = [];
    for (const child of where.all) {
      const parsed = parseCondition(child);
      if (parsed) conditions.push(parsed);
      else residual.push(child);
    }
    return { conditions, ...(residual.length ? { residual: residual.length === 1 ? residual[0] : { all: residual } } : {}) };
  }
  const parsed = parseCondition(where);
  return parsed ? { conditions: [parsed] } : { conditions: [], residual: where };
}

/** Round-trips the condition rows saved in a view; unparsed expressions remain as advanced filters. */
export function splitTaskFilterView(view: ViewConfig): {
  conditions: TaskFilterCondition[];
  filter?: Record<string, unknown>;
  where?: ViewConfig['where'];
} {
  const conditions: TaskFilterCondition[] = [];
  const filter = { ...(view.filter ?? {}) };
  for (const field of ['status', 'priority', 'assignee'] as const) {
    const value = filter[field];
    if (typeof value === 'string' && value) {
      conditions.push({ field, operator: 'is', values: [value] });
      delete filter[field];
    }
  }
  const split = view.where ? splitWhere(view.where) : { conditions: [] };
  return {
    conditions: [...conditions, ...split.conditions],
    ...(Object.keys(filter).length ? { filter } : {}),
    ...(split.residual ? { where: split.residual } : {}),
  };
}
