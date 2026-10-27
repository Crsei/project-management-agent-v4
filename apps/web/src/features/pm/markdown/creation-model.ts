import { z } from 'zod';
import { customFieldSchema, entityKinds, fieldRegistry, workflowFor, type Diagnostic, type EntityKind, type ProtocolConfiguration } from '../../../../../../packages/pm-schema/index.ts';
import type { CoreCreationAttempt } from '../../../../../../packages/contracts/src/core-creation.ts';
import type { Command, CommandReceipt } from '../../../../../../packages/contracts/src/client.ts';
import { localDirectorySchema, type LocalDirectory, type LocalProjectAttempt } from '../../../../../../packages/contracts/src/local-projects.ts';

export interface CreationInitial { entity?: EntityKind; project?: string; status?: string; assignee?: string; due?: string; watch?: boolean; priority?: string }
export type NativeCreationPhase = 'prepared' | 'sending' | 'unknown' | 'rejected' | 'committed';
export interface NativeCreationAttempt {
  key: string;
  request: Record<string, unknown>;
  localDirectory?: LocalDirectory;
  phase: NativeCreationPhase;
  message: string;
  diagnostics: Diagnostic[];
  entityId?: string;
  revision?: string;
  currentStatus?: 'present' | 'deleted' | 'missing' | 'unavailable';
}
export interface CreationChild { draftId: string; values: Record<string, unknown>; body: string; attempt?: NativeCreationAttempt }
export interface CreationWatchAttempt { command: Command<'WatchTask'>; phase: 'sending' | 'unknown' | 'rejected' | 'committed'; message: string; receipt?: CommandReceipt }
export interface CreationDraft {
  draftId: string;
  kind: EntityKind;
  values: Record<string, unknown>;
  body: string;
  localDirectory?: LocalDirectory;
  children: CreationChild[];
  watch: boolean;
  initial: CreationInitial;
  updatedAt: number;
  attempt?: NativeCreationAttempt;
  watchAttempt?: CreationWatchAttempt;
}
export type CreationDrafts = Record<string, CreationDraft>;

const nativeAttemptSchema = z.object({
  key: z.string().min(1), request: z.record(z.string(), z.unknown()),
  localDirectory: localDirectorySchema.optional(),
  phase: z.enum(['prepared', 'sending', 'unknown', 'rejected', 'committed']), message: z.string(),
  diagnostics: z.array(z.object({ code: z.string(), severity: z.enum(['error', 'warning']), path: z.string(), message: z.string() }).passthrough()),
  entityId: z.string().optional(), revision: z.string().optional(),
  currentStatus: z.enum(['present', 'deleted', 'missing', 'unavailable']).optional(),
});
const watchAttemptSchema = z.object({
  command: z.object({ commandId: z.string().uuid(), commandType: z.literal('WatchTask'), projectId: z.string(), payload: z.object({ taskId: z.string() }).strict() }).strict(),
  phase: z.enum(['sending', 'unknown', 'rejected', 'committed']), message: z.string(), receipt: z.unknown().optional(),
});
const draftSchema = z.object({
  draftId: z.string().min(1), kind: z.enum(entityKinds), values: z.record(z.string(), z.unknown()), body: z.string(),
  localDirectory: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('existing'), path: z.string() }),
    z.object({ mode: z.literal('new'), parentPath: z.string(), folderName: z.string() }),
  ]).optional(),
  children: z.array(z.object({ draftId: z.string().min(1), values: z.record(z.string(), z.unknown()), body: z.string(), attempt: nativeAttemptSchema.optional() })),
  watch: z.boolean(), initial: z.object({ entity: z.enum(entityKinds).optional(), project: z.string().optional(), status: z.string().optional(), assignee: z.string().optional(), due: z.string().optional(), watch: z.boolean().optional(), priority: z.string().optional() }),
  updatedAt: z.number(), attempt: nativeAttemptSchema.optional(), watchAttempt: watchAttemptSchema.optional(),
});

/** Invalid journals are not silently replaced with an empty store. */
export function decodeCreationDrafts(text: string | null): CreationDrafts {
  if (text === null) return {};
  const values = z.record(z.string(), draftSchema).parse(JSON.parse(text));
  for (const [id, draft] of Object.entries(values)) {
    if (id !== draft.draftId) throw new Error('Creation draft identity does not match its storage key.');
    if (draft.attempt?.phase === 'sending') draft.attempt.phase = 'unknown';
    for (const child of draft.children) if (child.attempt?.phase === 'sending') child.attempt.phase = 'unknown';
    if (draft.watchAttempt?.phase === 'sending') draft.watchAttempt.phase = 'unknown';
  }
  return values as CreationDrafts;
}
export function initialCreationValues(kind: EntityKind, configuration: ProtocolConfiguration, initial: CreationInitial = {}): Record<string, unknown> {
  const workflow = workflowFor(kind, configuration);
  return {
    ...Object.fromEntries(fieldRegistry.filter(field => field.editable && field.name !== 'archived' && field.entities.includes(kind) && field.default !== undefined && (typeof field.default !== 'object' || Array.isArray(field.default))).map(field => [field.name, structuredClone(field.default)])),
    ...Object.fromEntries(configuration.custom_fields.filter(field => field.entities.includes(kind) && field.default !== undefined).map(field => [field.name, structuredClone(field.default)])),
    title: '', ...(kind !== 'project' && initial.project ? { project: initial.project } : {}),
    ...(workflow ? { status: initial.status || workflow.initial } : {}),
    ...(kind === 'work_item' ? { ...(initial.assignee ? { assignee: initial.assignee } : {}), ...(initial.due ? { due: initial.due } : {}), ...(initial.priority ? { priority: initial.priority } : {}) } : {}),
  };
}
export function newCreationDraft(draftId: string, configuration: ProtocolConfiguration, initial: CreationInitial = {}, now = Date.now()): CreationDraft {
  const kind = initial.entity ?? 'work_item';
  return { draftId, kind, values: initialCreationValues(kind, configuration, initial), body: '', children: [], watch: kind === 'work_item' && initial.watch === true, initial: { ...initial }, updatedAt: now };
}
export function creationDraftEditable(draft: CreationDraft): boolean { return !draft.attempt; }
/** An untouched draft may adopt a new entry's initial status/project without losing user work. */
export function creationDraftIsPristine(draft: CreationDraft, configuration: ProtocolConfiguration): boolean {
  if (draft.attempt || draft.children.length || draft.body.trim() || draft.watch) return false;
  const defaults = initialCreationValues(draft.kind, configuration, draft.initial);
  const keys = new Set([...Object.keys(defaults), ...Object.keys(draft.values)]);
  return [...keys].every(key => JSON.stringify(draft.values[key] ?? null) === JSON.stringify(defaults[key] ?? null));
}
/** Blank rows are unfinished UI placeholders; any typed content or frozen attempt is kept. */
export function creationChildHasContent(child: CreationChild): boolean {
  return !!child.attempt || String(child.values.title ?? '').trim() !== '' || child.body.trim() !== '' || !!child.values.assignee;
}
export function hasUncertainCreationDrafts(drafts: Readonly<CreationDrafts>): boolean {
  return Object.values(drafts).some(draft => [draft.attempt, ...draft.children.map(child => child.attempt), draft.watchAttempt].some(attempt => attempt?.phase === 'sending' || attempt?.phase === 'unknown'));
}
export function creationComplete(draft: CreationDraft): boolean {
  return draft.attempt?.phase === 'committed' && draft.children.every(child => child.attempt?.phase === 'committed') && (!draft.watch || draft.watchAttempt?.phase === 'committed');
}
export function creationHasRemainingNativeWrites(draft: CreationDraft): boolean {
  return draft.attempt?.phase !== 'committed' || draft.children.some(child => child.attempt?.phase !== 'committed');
}
export function resumableCreationDraft(drafts: Readonly<CreationDrafts>, kind: EntityKind, project?: string): CreationDraft | undefined {
  const candidates = Object.values(drafts).filter(draft => !creationComplete(draft)
    && (project === undefined || (draft.initial.project || '') === project && (!project || draft.kind !== 'project' && draft.values.project === project))).sort((a, b) => b.updatedAt - a.updatedAt);
  return candidates.find(draft => [draft.attempt, ...draft.children.map(child => child.attempt), draft.watchAttempt].some(attempt => attempt?.phase === 'unknown' || attempt?.phase === 'sending')) ?? candidates.find(draft => draft.kind === kind);
}
export function editCreationDraft(draft: CreationDraft, changes: Partial<Pick<CreationDraft, 'values' | 'body' | 'children' | 'watch' | 'localDirectory'>>): CreationDraft {
  if (!creationDraftEditable(draft)) throw new Error('This creation intent is frozen. Reconcile its original request before editing.');
  return { ...draft, ...changes, updatedAt: Date.now() };
}
export function creationRequest(kind: EntityKind, values: Record<string, unknown>, body: string, configuration: ProtocolConfiguration): Record<string, unknown> {
  const allowed = new Set([...fieldRegistry.filter(field => field.editable && field.name !== 'archived' && field.entities.includes(kind)).map(field => field.name), ...configuration.custom_fields.filter(field => field.entities.includes(kind)).map(field => field.name)]);
  const fields = Object.fromEntries(Object.entries(values).filter(([name, value]) => allowed.has(name) && value !== null && value !== undefined));
  return structuredClone({ ...fields, entity: kind, body });
}
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
/** Preflight the whole group without inventing an entity ID. Server remains authority. */
export function creationFieldIssues(kind: EntityKind, values: Record<string, unknown>, configuration: ProtocolConfiguration): Diagnostic[] {
  const issues: Diagnostic[] = [];
  const issue = (field: string, message: string) => issues.push({ code: 'CREATION_INPUT', severity: 'error', path: '', field, message });
  if (typeof values.title !== 'string' || !values.title.trim() || /[\r\n]/.test(values.title)) issue('title', 'Enter a nonempty, single-line title. / 请输入非空单行标题。');
  const projectField = fieldRegistry.find(field => field.name === 'project' && field.entities.includes(kind));
  if ((kind === 'work_item' || projectField && !projectField.nullable) && !values.project) issue('project', 'Choose an authorized project. / 请选择有权访问的项目。');
  const workflow = workflowFor(kind, configuration);
  if (workflow && !workflow.states.some(state => state.id === values.status)) issue('status', 'Choose a configured workflow state. / 请选择有效工作流状态。');
  for (const field of fieldRegistry.filter(field => field.editable && field.entities.includes(kind))) {
    const value = values[field.name];
    if (value === undefined || value === null || field.name === 'title') continue;
    if (field.type === 'date' && (typeof value !== 'string' || !validDate(value))) issue(field.name, 'Enter a real YYYY-MM-DD date. / 请输入有效日期。');
    if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) issue(field.name, 'Enter a finite number. / 请输入有效数字。');
    if (field.type.startsWith('enum:') && !field.type.slice(5).split('|').includes(String(value))) issue(field.name, 'Choose an available value. / 请选择有效值。');
    if (field.type.endsWith('[]') && (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim()))) issue(field.name, 'Use nonempty text values. / 列表值不能为空。');
  }
  const start = values[kind === 'work_item' ? 'x-pm-start' : 'start'];
  if (typeof start === 'string' && typeof values.due === 'string' && start > values.due) issue('due', 'Due date cannot precede start date. / 截止日期不能早于开始日期。');
  if (kind === 'work_item') {
    const points = values['x-pm-estimate'];
    if (points !== undefined && points !== null && (typeof points !== 'number' || !Number.isFinite(points) || points < 0 || points > 1_000_000)) issue('x-pm-estimate', 'Estimate must be between 0 and 1,000,000. / 估算范围为 0 至 1,000,000。');
    const location = values['x-pm-location'];
    if (location !== undefined && location !== null && (typeof location !== 'string' || location.trim().length > 1000)) issue('x-pm-location', 'Location is plain text, at most 1,000 characters. / 位置最多 1,000 字符。');
  }
  for (const field of configuration.custom_fields.filter(field => field.entities.includes(kind))) {
    const value = values[field.name];
    if ((value === undefined || value === null) && !field.required) continue;
    const result = customFieldSchema(field).safeParse(value);
    if (!result.success) issue(field.name, result.error.issues.map(error => error.message).join('; '));
  }
  return issues;
}
export function prepareCreationAttempt(request: Record<string, unknown>, key: string): NativeCreationAttempt {
  return { key, request: structuredClone(request), phase: 'prepared', message: '', diagnostics: [] };
}
export function applyCreationResult(attempt: NativeCreationAttempt, result: CoreCreationAttempt): NativeCreationAttempt {
  if (attempt.phase === 'committed') return attempt;
  if (result.status === 'committed') return { ...attempt, phase: 'committed', entityId: result.entityId, revision: result.revision, currentStatus: result.current.status, message: '', diagnostics: [] };
  if (result.status === 'rejected') return { ...attempt, phase: 'rejected', message: 'The server confirmed rejection. Review this draft before starting a new attempt. / 服务端已确认拒绝；请检查草稿后开始新请求。' };
  return { ...attempt, phase: 'unknown', message: result.status === 'not_found' ? 'No confirmable record. This does not prove the request was never received; the original key remains frozen. / 无可确认记录不表示请求未到达，原请求保持冻结。' : 'The original write or audit is still pending. No create request was replayed. / 原写入或审计仍待核对，未重放创建。' };
}
/** Local storage readiness is separate from native audit and PM command receipts. */
export function applyLocalProjectResult(attempt: NativeCreationAttempt, result: LocalProjectAttempt): NativeCreationAttempt {
  if (attempt.phase === 'committed') return attempt;
  if (result.status !== 'not_found' && (result.key !== attempt.key || result.operation !== 'initialize')) return { ...attempt, phase: 'unknown', message: 'Initialization result does not match the original request. / 初始化结果与原请求不一致。' };
  if (result.status === 'ready') {
    if (result.location.status !== 'available') return { ...attempt, phase: 'unknown', message: 'Initialization is recorded but storage is unavailable. Reconnect the original directory before recovering. / 初始化已登记但存储不可用，请恢复原目录后核对。' };
    return { ...attempt, phase: 'committed', entityId: result.record.id, revision: result.record.revision, currentStatus: 'present', message: '', diagnostics: [] };
  }
  if (result.status === 'rejected') return { ...attempt, phase: 'rejected', message: `Initialization rejected / 初始化已拒绝: ${result.code}` };
  return { ...attempt, phase: 'unknown', message: result.status === 'not_found'
    ? 'No confirmable initialization. This does not prove the request was never received; keep its original key and directory. / 未找到可确认初始化，不表示请求未到达；原键与目录保持冻结。'
    : `Initialization is incomplete / 初始化尚未完成: ${result.reason}. Recover this operation; do not create a replacement. / 请恢复原操作，不要重复建项。` };
}
/** Rejected parent means no child could have been sent; committed parents never reset. */
export function editRejectedCreation(draft: CreationDraft): CreationDraft {
  if (draft.attempt?.phase !== 'rejected') throw new Error('Only confirmed rejected requests can be edited.');
  const { attempt: _attempt, watchAttempt: _watch, ...editable } = draft;
  return { ...editable, updatedAt: Date.now() };
}
export function editRejectedChild(draft: CreationDraft, childId: string): CreationDraft {
  if (draft.attempt?.phase !== 'committed') throw new Error('Confirm the parent before repairing a child.');
  return { ...draft, children: draft.children.map(child => {
    if (child.draftId !== childId) return child;
    if (child.attempt?.phase !== 'rejected') throw new Error('Only a confirmed rejected child can be edited.');
    const { attempt: _attempt, ...editable } = child;
    return editable;
  }), updatedAt: Date.now() };
}
