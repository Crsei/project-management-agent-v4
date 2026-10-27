import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { createMarkdown, inspectFrontmatter, parseMarkdown, titleLineIndex, wikiTarget, type SyntaxNode } from '../pm-markdown/index.ts';
import { fieldRegistry, workflowFor, type FileRecord, type ProtocolConfiguration } from '../pm-schema/index.ts';
import { createReferenceResolver, relationFields } from '../pm-schema/relations.ts';
import { revisionOf } from './repository.ts';

export type ProjectCopyInput = { name: string; includeTasks: boolean };
export type ProjectCopyMapping = { sourceProjectId: string; taskIdMap: Record<string, string>; copiedTaskCount: number };
export type ProjectCopyResult = ProjectCopyMapping & { id: string; projectId: string };
const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath);
const safeExtensions: Record<string, true> = { 'x-pm-start': true, 'x-pm-estimate': true, 'x-pm-location': true, 'x-pm-completion-criteria': true, 'x-pm-icon': true, 'x-pm-color': true };
const plainText = (node: SyntaxNode): string => node.value ?? node.alt ?? node.children?.map(plainText).join('') ?? '';
const literal = (text: string): string => text.replace(/[\\`*_[\]<>]/g, '\\$&');

/** Rewrite only active Markdown syntax, not code examples, escaped links or hidden comments. */
function copiedBody(record: FileRecord, files: FileRecord[], ids: Map<string, string>, title: string): string {
  const section = inspectFrontmatter(record.raw), body = section.body;
  const titleLine = (titleLineIndex(record.raw) ?? section.bodyLineOffset) - section.bodyLineOffset;
  const lines = body.split(/\r?\n/);
  // createMarkdown supplies the authoritative heading, preserving all other prose.
  lines.splice(titleLine, 1);
  const source = lines.join('\n').replace(/^\s*\n/, '');
  const resolver = createReferenceResolver(files);
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: SyntaxNode): void => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) { node.children?.forEach(visit); return; }
    if (node.type === 'code') {
      // Preserve query text as inert YAML, not an active query selecting source-project data.
      if ('lang' in node && node.lang === 'pm-view') edits.push({ start, end, text: source.slice(start, end).replace(/^([ \t]*(?:`{3,}|~{3,}))[ \t]*pm-view\b/, '$1yaml') });
      return;
    }
    if (['inlineCode', 'math', 'inlineMath', 'html'].includes(node.type)) return;
    if (node.type === 'text') {
      const raw = source.slice(start, end);
      for (const match of raw.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
        let slashes = 0;
        for (let offset = match.index - 1; offset >= 0 && raw[offset] === '\\'; offset--) slashes++;
        if (slashes % 2) continue;
        const target = wikiTarget(match[2]!);
        const resolved = resolver.resolve(target.id).file;
        const replacement = resolved && ids.get(resolved.id);
        const label = target.label || resolved?.entity.title || target.id;
        edits.push({ start: start + match.index, end: start + match.index + match[0].length,
          text: replacement ? `${match[1]}[[${replacement}${target.fragment ? '#' + target.fragment : ''}|${label === record.entity.title ? title : label}]]` : literal(label) });
      }
      return;
    }
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
      const url = node.url ?? '';
      const entityUrl = /\/(?:projects|tasks|entity|entities|files)\/([A-Z][A-Z0-9]*-\d+)(?:[/?#]|$)/.exec(url);
      const attachmentUrl = /\/(?:artifact-versions|artifacts|attachments)\//.test(url);
      if (/^(?:https?:|mailto:|#(?!entity:))/i.test(url) && !entityUrl && !attachmentUrl) return;
      let target = url;
      try { target = entityUrl?.[1] ?? decodeURIComponent(url.replace(/^#entity:/, '')); } catch { /* Invalid local URLs become plain text. */ }
      const resolved = resolver.resolve(target.replace(/^.*\//, '').replace(/\.md(?:#.*)?$/, '')).file;
      const replacement = resolved && ids.get(resolved.id);
      edits.push({ start, end, text: replacement && node.type !== 'definition' ? `[[${replacement}|${plainText(node) || resolved?.entity.title || replacement}]]` : literal(plainText(node)) });
      return;
    }
    if (node.type === 'listItem' && node.checked === true) {
      const prefix = /^(\s*(?:[-+*]|\d+[.)])\s+\[)[xX](\])/.exec(source.slice(start, end));
      if (prefix) edits.push({ start: start + prefix[1]!.length, end: start + prefix[1]!.length + 1, text: ' ' });
    }
    node.children?.forEach(visit);
  };
  visit(parser.parse(source) as SyntaxNode);
  let output = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return output.trimEnd();
}

/** Only substantive protocol/custom fields are copied; server provenance/history is never inherited. */
export function projectCopyRecords(files: FileRecord[], source: FileRecord, tasks: FileRecord[], ids: Map<string, string>, input: ProjectCopyInput, configuration: ProtocolConfiguration, local: boolean): FileRecord[] {
  const relations = relationFields(configuration);
  return [source, ...tasks].map(record => {
    const { metadata } = inspectFrontmatter(record.raw);
    const kind = record.entity.entity;
    const fields: Record<string, unknown> = {};
    const allowed = new Set([...fieldRegistry.filter(field => field.source === 'yaml' && field.entities.includes(kind)).map(field => field.name),
      ...configuration.custom_fields.filter(field => field.entities.includes(kind)).map(field => field.name), ...Object.keys(safeExtensions)]);
    for (const [field, value] of Object.entries(metadata)) {
      if (!allowed.has(field) || ['schema', 'id', 'entity', 'title', 'status', 'archived'].includes(field)) continue;
      fields[field] = value;
    }
    for (const relation of relations.filter(relation => relation.entities.includes(kind))) {
      const value = fields[relation.name];
      if (relation.multiple) fields[relation.name] = Array.isArray(value) ? value.flatMap(id => typeof id === 'string' && ids.has(id) ? [ids.get(id)!] : []) : [];
      else if (typeof value === 'string' && ids.has(value)) fields[relation.name] = ids.get(value)!;
      else delete fields[relation.name];
    }
    const id = ids.get(record.id)!;
    const title = record.id === source.id ? input.name : record.entity.title;
    const raw = createMarkdown({ ...fields, id, entity: kind, title, status: workflowFor(kind, configuration)!.initial,
      archived: false, body: copiedBody(record, files, ids, title) }, configuration);
    const directory = kind === 'project' ? 'projects' : 'work-items';
    return { id, path: `${local ? `project-roots/${ids.get(source.id)!}/` : ''}${directory}/${id}.md`, raw, revision: revisionOf(raw),
      entity: parseMarkdown(raw, configuration) };
  });
}
