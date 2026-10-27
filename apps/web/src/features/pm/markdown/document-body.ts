import { parseMarkdown, patchMarkdown } from '../../../../../../packages/pm-markdown/index.ts';
import { ProtocolError, type FileRecord, type ProtocolConfiguration } from '../../../../../../packages/pm-schema/index.ts';

export interface DocumentBody { prefix: string; body: string }
export interface BodyChange { from: number; to: number; insert: string }

/** Split only at protocol delimiters; never parse or serialize the YAML prefix. */
export function splitDocumentBody(raw: string): DocumentBody | null {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(raw);
  if (!opening) return null;
  const delimiter = /^---[ \t]*(?:\r?\n|$)/gm;
  delimiter.lastIndex = opening[0].length;
  const closing = delimiter.exec(raw);
  if (!closing) return null;
  const offset = closing.index + closing[0].length;
  return { prefix: raw.slice(0, offset), body: raw.slice(offset) };
}

export function bodyEditorText(body: string): string { return body.replace(/\r\n?/g, '\n'); }

/** CodeMirror offsets count a CRLF as one character, protocol offsets count two. */
export function bodyOffsetFromEditor(body: string, offset: number): number {
  let source = 0;
  let editor = 0;
  while (source < body.length && editor < offset) {
    source += body[source] === '\r' && body[source + 1] === '\n' ? 2 : 1;
    editor++;
  }
  return source;
}

export function editorOffsetFromBody(body: string, offset: number): number {
  return bodyEditorText(body.slice(0, offset)).length;
}

/** Apply a CM change set to raw body bytes, retaining untouched mixed line endings. */
export function applyBodyChanges(body: string, changes: readonly BodyChange[]): string {
  const newline = /\r\n|\n|\r/.exec(body)?.[0] ?? '\n';
  let cursor = 0;
  let result = '';
  for (const change of changes) {
    const from = bodyOffsetFromEditor(body, change.from);
    const to = bodyOffsetFromEditor(body, change.to);
    if (from < cursor || to < from) throw new Error('The editor change set is not ordered.');
    result += body.slice(cursor, from) + bodyEditorText(change.insert).replace(/\n/g, newline);
    cursor = to;
  }
  return result + body.slice(cursor);
}

/** Property fields stage against the latest document raw; lifecycle remains a saved-source action. */
export function patchDocumentDraftRaw(file: FileRecord, raw: string, changes: Record<string, unknown>, configuration: ProtocolConfiguration): string {
  const entity = parseMarkdown(raw, configuration);
  const immutable = (['id', 'schema', 'entity'] as const).find(field => entity[field] !== file.entity[field]);
  if (immutable || entity.entity !== 'document') throw new ProtocolError([{
    code: 'IMMUTABLE_FIELD', severity: 'error', path: file.path, entityId: file.id, field: immutable || 'entity',
    message: `The ${immutable || 'entity'} field cannot be changed.`,
  }]);
  if (file.entity.archived || entity.archived) throw new Error('Archived sources are read-only.');
  if (Object.hasOwn(changes, 'archived')) throw new Error('Resolve the draft before using the saved-source lifecycle controls.');
  return patchMarkdown(raw, changes, configuration);
}
