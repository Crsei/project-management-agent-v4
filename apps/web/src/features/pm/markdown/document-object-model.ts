import { z } from 'zod';
import { inspectFrontmatter, parseMarkdown, patchMarkdown } from '../../../../../../packages/pm-markdown/index.ts';
import type { FileRecord, ProtocolConfiguration } from '../../../../../../packages/pm-schema/index.ts';
import type { CommandReceipt } from '../../../../../../packages/contracts/src/client.ts';
import { editCreationDraft } from './creation-model.ts';
import type { CreationStore } from './creation-store.ts';

export interface DocumentObjectSelection { text: string; from: number; to: number }
export interface DocumentObjectSource { id: string; raw: string; revision: string; selection: DocumentObjectSelection }
const selectionSchema = z.object({ text: z.string(), from: z.number().int().nonnegative(), to: z.number().int().nonnegative() });
const sourceSchema = z.object({ id: z.string().min(1), raw: z.string(), revision: z.string(), selection: selectionSchema });
const taskSchema = z.object({ kind: z.literal('task'), id: z.string(), source: sourceSchema, draftId: z.string(), projectId: z.string().optional(), taskId: z.string().optional(), inserted: z.boolean(), insertion: z.enum(['reserved', 'inserted']).optional() });
const uploadSchema = z.object({
  kind: z.literal('upload'), id: z.string(), source: sourceSchema, projectId: z.string(), name: z.string(), mediaType: z.string(),
  phase: z.enum(['selected', 'staging', 'staged', 'registering', 'unknown', 'rejected', 'done']), step: z.enum(['stage', 'register']).optional(),
  commandId: z.string().optional(), uploadId: z.string().optional(), uploadVersion: z.number().optional(), versionId: z.string().optional(), error: z.string(), inserted: z.boolean(), insertion: z.enum(['reserved', 'inserted']).optional(),
});
export type DocumentTaskAction = z.infer<typeof taskSchema>;
export type DocumentUploadAction = z.infer<typeof uploadSchema>;
export type DocumentObjectAction = DocumentTaskAction | DocumentUploadAction;
export type DocumentObjectJournal = Record<string, DocumentObjectAction>;

export function captureDocumentObjectSource(id: string, raw: string, revision: string, selection: DocumentObjectSelection): DocumentObjectSource {
  const body = inspectFrontmatter(raw).body;
  if (!id || !Number.isInteger(selection.from) || !Number.isInteger(selection.to) || selection.from < 0 || selection.to < selection.from || selection.to > body.length || body.slice(selection.from, selection.to) !== selection.text) throw new Error('The document selection is stale. Select the text again. / 文档选区已过期，请重新选择。');
  return { id, raw, revision, selection: { ...selection } };
}
export function documentObjectSourceMatches(source: DocumentObjectSource, current: DocumentObjectSource): boolean {
  return source.id === current.id && source.raw === current.raw && source.revision === current.revision && source.selection.from === current.selection.from && source.selection.to === current.selection.to && source.selection.text === current.selection.text;
}
export function relatedDocumentDraft(raw: string, targetId: string, configuration: ProtocolConfiguration): string {
  const entity = parseMarkdown(raw, configuration);
  if (entity.id === targetId) throw new Error('An object cannot relate to itself. / 对象不能关联自身。');
  return entity.related_to.includes(targetId) ? raw : patchMarkdown(raw, { related_to: [...entity.related_to, targetId] }, configuration);
}
/** Called under the creation lock before submit, after queued keystroke backups. */
export function flushDocumentTaskFields(store: CreationStore, draftId: string, fields: { title: string; project: string | null }): void {
  const saved = store.commit(current => {
    const draft = current[draftId];
    if (!draft || draft.kind !== 'work_item') throw new Error('The original task draft is unavailable. No replacement task was created. / 原任务草稿不可用，未创建替代任务。');
    return { ...current, [draftId]: editCreationDraft(draft, { values: { ...draft.values, title: fields.title, project: fields.project } }) };
  });
  if (!saved) throw new Error('The final title and project could not be saved to recovery storage. No create was sent. / 最终标题和项目无法保存到恢复存储，未发送创建。');
}
export function documentTaskTitle(text: string): string {
  const title = text.split(/\r?\n/).map(line => line.replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, '').replace(/^\s*#{1,6}\s+/, '').trim()).find(Boolean);
  if (!title) throw new Error('Select text or a checklist item first. / 请先选择文本或检查项。');
  return title;
}
/** A confirmed file may outlive the browser's completion callback; absence never authorizes recreation. */
export function recoverDocumentTaskReference(action: DocumentTaskAction, files: readonly FileRecord[]): FileRecord {
  const marker = `<!-- pm-document-conversion:${action.draftId.replace(/^document-conversion:/, '')} -->`;
  const matches = files.filter(file => file.entity.entity === 'work_item' && file.entity.related_to.includes(action.source.id) && file.entity.body.includes(marker));
  if (matches.length !== 1) throw new Error(matches.length ? 'More than one source-linked task matches this intent; no automatic choice was made. / 多个任务匹配此来源，未自动选择。' : 'No authorized task can confirm this intent. Absence does not prove failure; the original intent remains frozen. / 未找到可确认的授权任务；缺失不表示失败，原意图保持冻结。');
  return matches[0]!;
}
export function documentTaskReference(text: string, taskId: string): string {
  return `${text}${text ? /\r?\n/.test(text) ? '\n\n' : ' ' : ''}[[${taskId}]]`;
}
export function documentWikiLink(id: string, title: string): string {
  return `[[${id}|${title.replace(/[\[\]|\r\n]/g, ' ').trim() || id}]]`;
}
export function documentAttachmentMarkdown(versionId: string, name: string, mediaType: string): string {
  const label = name.replace(/([\\\[\]])/g, '\\$1').replace(/[\r\n]/g, ' ');
  const embeddedMedia = /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/i.test(mediaType) || /^(?:audio|video)\//i.test(mediaType) || mediaType.toLowerCase() === 'application/pdf';
  return `${embeddedMedia ? '!' : ''}[${label}](pm-attachment:${encodeURIComponent(versionId)})`;
}
export function decodeDocumentObjectJournal(text: string | null): DocumentObjectJournal {
  if (text === null) return {};
  const entries = z.record(z.string(), z.discriminatedUnion('kind', [taskSchema, uploadSchema])).parse(JSON.parse(text));
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.id !== id) throw new Error('Document action journal identity mismatch.');
    if (entry.kind === 'upload' && (entry.phase === 'staging' || entry.phase === 'registering')) entry.phase = 'unknown';
  }
  return entries;
}
/** A missing receipt is not evidence of rejection; only a real receipt settles a write. */
export function applyDocumentUploadReceipt(action: DocumentUploadAction, receipt: CommandReceipt): DocumentUploadAction {
  if (receipt.commandId !== action.commandId) throw new Error('The receipt belongs to another upload command.');
  if (receipt.status === 'rejected') return { ...action, phase: 'rejected', error: receipt.error.message };
  if (action.step === 'stage') {
    const { upload } = z.object({ upload: z.object({ id: z.string().min(1), version: z.number().int().positive() }) }).parse(receipt.result);
    return { ...action, phase: 'staged', uploadId: upload.id, uploadVersion: upload.version, error: '' };
  }
  if (action.step === 'register') {
    const { artifactVersion } = z.object({ artifactVersion: z.object({ id: z.string().min(1) }) }).parse(receipt.result);
    return { ...action, phase: 'done', versionId: artifactVersion.id, error: '' };
  }
  throw new Error('The upload command has no recorded step.');
}

export interface DocumentObjectStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface DocumentObjectStore {
  getSnapshot: () => DocumentObjectJournal;
  subscribe: (listener: () => void) => () => void;
  persistenceError: () => boolean;
  refresh: () => void;
  commit: (change: (current: DocumentObjectJournal) => DocumentObjectJournal) => boolean;
}
/** Durable source checkpoints survive remounts; failed persistence never authorizes dispatch. */
export function createDocumentObjectStore(key: string, storage: DocumentObjectStorage): DocumentObjectStore {
  let value: DocumentObjectJournal = {};
  let failed = false;
  let serialized: string | null = null;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  function refresh() {
    try {
      const text = storage.getItem(key);
      if (text === serialized && !failed) return;
      value = decodeDocumentObjectJournal(text);
      serialized = text;
      failed = false;
    } catch { failed = true; }
    notify();
  }
  refresh();
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    persistenceError: () => failed,
    refresh,
    commit: (change: (current: DocumentObjectJournal) => DocumentObjectJournal): boolean => {
      refresh();
      if (failed) return false;
      const next = change(value);
      try {
        const text = JSON.stringify(next);
        storage.setItem(key, text);
        serialized = text;
        value = next;
        failed = false;
        notify();
        return true;
      } catch { failed = true; notify(); return false; }
    },
  };
}
