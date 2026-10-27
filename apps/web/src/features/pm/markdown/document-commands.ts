import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { DocumentCommand, DocumentCommandDefinition, DocumentEdit, DocumentSelection } from './document-editing-types.ts';

type Node = { type: string; depth?: number; value?: string; alt?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
type Span = { from: number; to: number; node: Node };
type Replacement = { from: number; to: number; insert: string };
type Line = { from: number; to: number; text: string };
const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false });
const colors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
const definition = (id: string, label: string, labelEn: string, group: DocumentCommandDefinition['group'], input?: DocumentCommandDefinition['input']): DocumentCommandDefinition => ({ id, label, labelEn, group, ...(input ? { input } : {}) });
const prompt = (label: string, labelEn: string, initial = '') => ({ label, labelEn, initial });

/** IDs and input fields are shared by the toolbar, command palette and slash menu. */
export const documentCommands: DocumentCommandDefinition[] = [
  definition('bold', '粗体', 'Bold', 'text'), definition('italic', '斜体', 'Italic', 'text'),
  definition('bolditalic', '粗斜体', 'Bold italic', 'text'), definition('strike', '删除线', 'Strikethrough', 'text'),
  definition('inline-code', '行内代码', 'Inline code', 'text'), definition('underline', '下划线', 'Underline', 'text'),
  definition('superscript', '上标', 'Superscript', 'text'), definition('subscript', '下标', 'Subscript', 'text'),
  ...colors.map((color, index) => definition(`highlight-${color}`, `${['红色', '橙色', '黄色', '绿色', '蓝色', '紫色'][index]}高亮`, `${color[0]!.toUpperCase()}${color.slice(1)} highlight`, 'text')),
  definition('color', '文字颜色', 'Text color', 'text', prompt('颜色：red / orange / yellow / green / blue / purple / pink / #RRGGBB', 'Color: red / orange / yellow / green / blue / purple / pink / #RRGGBB', 'blue')),
  definition('font', '字体', 'Font', 'text', prompt('字体：sans / serif / mono', 'Font: sans / serif / mono', 'sans')),
  definition('font-size', '字号', 'Font size', 'text', prompt('字号：small / normal / large / huge', 'Size: small / normal / large / huge', 'large')),
  definition('clear-formatting', '清除格式', 'Clear formatting', 'text'),
  definition('paragraph', '普通段落', 'Paragraph', 'paragraph'),
  ...Array.from({ length: 6 }, (_, index) => definition(`heading-${index + 1}`, `${index + 1} 级标题`, `Heading ${index + 1}`, 'paragraph')),
  definition('ordered-list', '有序列表', 'Ordered list', 'paragraph'), definition('unordered-list', '无序列表', 'Unordered list', 'paragraph'),
  definition('task-list', '任务列表', 'Task list', 'paragraph'), definition('blockquote', '引用', 'Blockquote', 'paragraph'),
  definition('indent', '增加缩进', 'Indent', 'paragraph'), definition('outdent', '减少缩进', 'Outdent', 'paragraph'),
  definition('link', '外部链接', 'External link', 'insert', prompt('链接地址', 'Link URL', 'https://')),
  definition('internal-link', '内部链接', 'Internal link', 'insert', prompt('对象 ID 或笔记目标，可加 |显示名称', 'Object ID or note target, optionally |label')),
  definition('image', '图片', 'Image', 'insert', prompt('图片地址', 'Image URL', 'https://')),
  definition('code-block', '代码块', 'Fenced code block', 'insert', prompt('代码语言（可留空）', 'Code language (optional)', 'text')),
  definition('horizontal-rule', '分隔线', 'Horizontal rule', 'insert'), definition('table', '表格', 'Table', 'insert'),
  definition('callout', '提示块', 'Callout', 'insert', prompt('类型|标题（标题可选）', 'Type|title (title optional)', 'note|')),
  definition('formula-inline', '行内公式', 'Inline formula', 'insert'), definition('formula-block', '公式块', 'Block formula', 'insert'),
  definition('mermaid', 'Mermaid 图表', 'Mermaid diagram', 'insert'),
  definition('footnote', '脚注', 'Footnote', 'insert', prompt('脚注 ID（留空自动编号）', 'Footnote ID (blank for next number)')),
  definition('tag', '标签', 'Tag', 'insert', prompt('标签（不含 #）', 'Tag (without #)')),
  definition('document-embed', '嵌入文档', 'Embed document', 'insert', prompt('文档 ID，可加 #标题或 #^块 ID', 'Document ID, optionally #heading or #^block')),
  definition('comment', '隐藏批注', 'Hidden comment', 'insert'),
  definition('template', '插入模板', 'Insert template', 'template', prompt('Markdown 模板，或 JSON {template,title,date,time}；变量 {{title}} {{date}} {{time}}', 'Markdown template, or JSON {template,title,date,time}; variables {{title}} {{date}} {{time}}')),
];

function fail(message: string): never { throw new Error(message); }
function spansOf(text: string): Span[] {
  const spans: Span[] = [];
  const visit = (node: Node) => {
    const from = node.position?.start.offset, to = node.position?.end.offset;
    if (from !== undefined && to !== undefined) spans.push({ from, to, node });
    for (const child of node.children ?? []) visit(child);
  };
  visit(parser.parse(text) as Node);
  return spans;
}
function validateSelection(text: string, selection: DocumentSelection) {
  const { from, to } = selection;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > text.length) fail('Selection must be an ordered UTF-16 range within the document body.');
  for (const point of [from, to]) {
    if (point > 0 && text[point - 1] === '\r' && text[point] === '\n') fail('Selection cannot split a CRLF newline.');
    const before = text.charCodeAt(point - 1), after = text.charCodeAt(point);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) fail('Selection cannot split a Unicode surrogate pair.');
  }
}
function overlaps(range: DocumentSelection, span: { from: number; to: number }) {
  return range.from === range.to ? range.from >= span.from && range.from < span.to : range.from < span.to && range.to > span.from;
}
function guard(text: string, range: DocumentSelection, spans: Span[], allowInlineCode = false) {
  // This is a body-only API. Recognizable accidentally supplied frontmatter is never edited.
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(text);
  if (opening) {
    const rest = text.slice(opening[0].length);
    const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
    if (close && /^[A-Za-z_][\w-]*[ \t]*:/m.test(rest.slice(0, close.index)) && overlaps(range, { from: 0, to: opening[0].length + close.index + close[0].length })) fail('Frontmatter is not editable through body commands; use source or properties.');
  }
  for (const span of spans) {
    if (['code', 'html', 'definition', 'footnoteDefinition'].includes(span.node.type) && overlaps(range, span)) fail('This command is not applicable inside or across a code fence, code block, HTML block, or definition.');
    if (!allowInlineCode && span.node.type === 'inlineCode' && overlaps(range, span)) fail('This command is not applicable inside or across inline code.');
  }
}
function newline(text: string) { return text.includes('\r\n') ? '\r\n' : '\n'; }
function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let from = 0;
  while (from <= text.length) {
    const next = text.indexOf('\n', from);
    const end = next < 0 ? text.length : next;
    const to = end > from && text[end - 1] === '\r' ? end - 1 : end;
    lines.push({ from, to, text: text.slice(from, to) });
    if (next < 0) break;
    from = next + 1;
  }
  return lines;
}
function selectedLines(text: string, selection: DocumentSelection) {
  return linesOf(text).filter(line => selection.from === selection.to
    ? line.from <= selection.from && selection.from <= line.to
    : line.from < selection.to && line.to >= selection.from);
}
function edit(text: string, selection: DocumentSelection, replacements: Replacement[]): DocumentEdit {
  const changes = replacements.filter(change => text.slice(change.from, change.to) !== change.insert).sort((a, b) => a.from - b.from || a.to - b.to);
  if (!changes.length) fail('There is no applicable formatting to change at this selection.');
  for (let index = 1; index < changes.length; index++) if (changes[index]!.from < changes[index - 1]!.to) fail('The selection crosses incompatible Markdown boundaries.');
  const map = (point: number, bias: -1 | 1) => {
    let offset = 0;
    for (const change of changes) {
      if (point < change.from || (point === change.from && change.from === change.to && bias < 0)) break;
      if (point >= change.to) { offset += change.insert.length - (change.to - change.from); continue; }
      return change.from + offset + (point === change.from && bias > 0 ? change.insert.length : Math.min(point - change.from, change.insert.length));
    }
    return point + offset;
  };
  let result = '', cursor = 0;
  for (const change of changes) { result += text.slice(cursor, change.from) + change.insert; cursor = change.to; }
  result += text.slice(cursor);
  const from = map(selection.from, 1), to = selection.from === selection.to ? from : map(selection.to, -1);
  return { text: result, selection: { from: Math.min(from, to), to: Math.max(from, to) } };
}
function replace(text: string, selection: DocumentSelection, insert: string, from = 0, to = insert.length): DocumentEdit {
  if (text.slice(selection.from, selection.to) === insert) fail('The selected text already has this form.');
  return { text: text.slice(0, selection.from) + insert + text.slice(selection.to), selection: { from: selection.from + from, to: selection.from + to } };
}
function escaped(text: string, at: number) {
  let count = 0;
  while (at > 0 && text[--at] === '\\') count++;
  return count % 2 === 1;
}
function linePrefix(source: string) {
  const indent = /^[ \t]*/.exec(source)![0];
  const quotes = /^(?:>[ \t]*)*/.exec(source.slice(indent.length))![0];
  const rest = source.slice(indent.length + quotes.length);
  const marker = /^(?:#{1,6}[ \t]+|(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/.exec(rest)?.[0] ?? '';
  return { indent, quotes, marker, content: rest.slice(marker.length), prefixLength: indent.length + quotes.length + marker.length };
}
function inlineRanges(text: string, selection: DocumentSelection): DocumentSelection[] {
  if (selection.from === selection.to) return [selection];
  const ranges: DocumentSelection[] = [];
  for (const line of selectedLines(text, selection)) {
    let from = Math.max(selection.from, line.from), to = Math.min(selection.to, line.to);
    if (from === line.from) from += linePrefix(line.text).prefixLength;
    while (from < to && /[ \t]/.test(text[from]!)) from++;
    while (to > from && /[ \t]/.test(text[to - 1]!)) to--;
    if (from < to) ranges.push({ from, to });
  }
  if (!ranges.length) fail('Select some text rather than only whitespace or Markdown block markers.');
  return ranges;
}
function paired(text: string, range: DocumentSelection, open: string, close: string): { outer: DocumentSelection; inner: DocumentSelection } | undefined {
  const candidates = [range, { from: range.from - open.length, to: range.to + close.length }, { from: range.from - open.length, to: range.to }, { from: range.from, to: range.to + close.length }];
  for (const outer of candidates) {
    if (outer.from < 0 || outer.to > text.length || outer.to - outer.from <= open.length + close.length) continue;
    const inner = { from: outer.from + open.length, to: outer.to - close.length };
    if (open === '~' && (text[inner.from] === '~' || text[inner.to - 1] === '~')) continue;
    if (text.slice(outer.from, inner.from) === open && text.slice(inner.to, outer.to) === close && !escaped(text, outer.from) && !escaped(text, inner.to)) return { outer, inner };
  }
  return undefined;
}
function toggle(text: string, selection: DocumentSelection, spans: Span[], open: string, close = open, placeholder = 'text'): DocumentEdit {
  guard(text, selection, spans);
  if (escaped(text, selection.from)) fail('A formatting delimiter cannot follow an unmatched escape; include the escape in the selection.');
  if (selection.from === selection.to) return replace(text, selection, open + placeholder + close, open.length, open.length + placeholder.length);
  const ranges = inlineRanges(text, selection);
  const pairs = ranges.map(range => {
    const type = open === '**' ? 'strong' : open === '*' || open === '***' ? 'emphasis' : open === '~~' ? 'delete' : undefined;
    const candidates = [paired(text, range, open, close)];
    if (open === '*' || open === '**' || open === '***') candidates.push(paired(text, range, '_'.repeat(open.length), '_'.repeat(close.length)));
    const direct = candidates.find(pair => pair && (!type || spans.some(span => span.node.type === type && span.from === pair.outer.from && span.to === pair.outer.to)));
    if (direct || !type) return direct;
    // A visible selection can sit inside nested strong/emphasis markers. Remove
    // only the requested AST wrapper, leaving the other formatting in place.
    for (const span of spans) if (span.node.type === type && span.from <= range.from && span.to >= range.to) {
      let first = span.node, last = span.node;
      while (first.children?.length) first = first.children[0]!;
      while (last.children?.length) last = last.children[last.children.length - 1]!;
      const token = text.slice(span.from, span.from + open.length);
      if ((token === open || token === '_'.repeat(open.length)) && first.position?.start.offset === range.from && last.position?.end.offset === range.to) return { outer: { from: span.from, to: span.to }, inner: { from: span.from + open.length, to: span.to - close.length } };
    }
    return undefined;
  });
  if (pairs.every(Boolean)) return edit(text, selection, pairs.flatMap(pair => [{ from: pair!.outer.from, to: pair!.inner.from, insert: '' }, { from: pair!.inner.to, to: pair!.outer.to, insert: '' }]));
  for (const [index, range] of ranges.entries()) if (!pairs[index]) {
    if (escaped(text, range.from) || escaped(text, range.to)) fail('The selection ends at an unmatched escape; include the complete escaped text.');
    if ((open === '~' || open === '~~') && (text[range.from] === '~' || text[range.to - 1] === '~')) fail('Nested tilde formatting would create an ambiguous delimiter or code fence; select plain text instead.');
    const token = open.startsWith('*') || open.startsWith('~') ? open[0]! : close;
    for (let at = text.indexOf(token, range.from); at >= 0 && at < range.to; at = text.indexOf(token, at + token.length)) {
      if (escaped(text, at)) continue;
      if ((token === '*' || token === '~') && spans.some(span => ['strong', 'emphasis', 'delete'].includes(span.node.type) && at >= span.from && at < span.to)) continue;
      fail('The selection contains an unmatched formatting delimiter; escape it or select a complete formatted span.');
    }
    if (spans.some(span => {
      if (!['strong', 'emphasis', 'delete', 'link', 'image'].includes(span.node.type) || !overlaps(range, span) || range.from <= span.from && range.to >= span.to) return false;
      const count = span.node.type === 'strong' || span.node.type === 'delete' ? 2 : 1;
      return range.from !== span.from + count || range.to !== span.to - count;
    })) fail('Select the complete formatted span or its complete contents before changing formatting.');
  }
  return edit(text, selection, ranges.flatMap((range, index) => pairs[index] ? [] : [{ from: range.from, to: range.from, insert: open }, { from: range.to, to: range.to, insert: close }]));
}
function inlineCode(text: string, selection: DocumentSelection, spans: Span[]): DocumentEdit {
  guard(text, selection, spans, true);
  const existing = spans.find(span => span.node.type === 'inlineCode' && (span.from === selection.from && span.to === selection.to || (() => {
    const token = text.slice(span.from, span.to), ticks = /^`+/.exec(token)![0].length;
    const padding = token[ticks] === ' ' && token[token.length - ticks - 1] === ' ' && /[^ ]/.test(token.slice(ticks, -ticks)) ? 1 : 0;
    return selection.from === span.from + ticks + padding && selection.to === span.to - ticks - padding;
  })()));
  if (existing) return replace(text, { from: existing.from, to: existing.to }, existing.node.value ?? '', 0, (existing.node.value ?? '').length);
  if (spans.some(span => span.node.type === 'inlineCode' && overlaps(selection, span))) fail('Select the complete inline code span or its complete contents to remove code formatting.');
  const content = text.slice(selection.from, selection.to) || 'code';
  if (/[\r\n]/.test(content)) fail('Inline code cannot span lines; use a fenced code block.');
  const longest = Math.max(0, ...Array.from(content.matchAll(/`+/g), match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^`|`$/.test(content) || /^ .* $/.test(content) && /[^ ]/.test(content) ? ' ' : '';
  return replace(text, selection, fence + pad + content + pad + fence, fence.length + pad.length, fence.length + pad.length + content.length);
}
function paragraph(text: string, selection: DocumentSelection, spans: Span[], command: string): DocumentEdit {
  const lines = selectedLines(text, selection);
  if (!lines.length) fail('No editable line at the selection.');
  guard(text, { from: lines[0]!.from, to: lines[lines.length - 1]!.to }, spans, true);
  const extent = { from: lines[0]!.from, to: lines[lines.length - 1]!.to };
  if (spans.some(span => overlaps(extent, span) && (['table', 'thematicBreak'].includes(span.node.type) || span.node.type === 'heading' && /[\r\n]/.test(text.slice(span.from, span.to))))) fail('This line belongs to a table, separator or setext heading; use a structure command or source editing.');
  const parts = lines.map(line => linePrefix(line.text));
  const nonblank = lines.filter(line => line.text.trim());
  const active = (test: (index: number) => boolean) => nonblank.length > 0 && lines.every((line, index) => !line.text.trim() || test(index));
  const isHeading = /^heading-[1-6]$/.test(command);
  const heading = isHeading ? `${'#'.repeat(Number(command.slice(-1)))} ` : '';
  const remove = command === 'blockquote' ? active(index => parts[index]!.quotes.length > 0)
    : command === 'ordered-list' ? active(index => /^\d+[.)][ \t]+/.test(parts[index]!.marker))
    : command === 'unordered-list' ? active(index => /^[-+*][ \t]+$/.test(parts[index]!.marker))
    : command === 'task-list' ? active(index => /^[-+*][ \t]+\[[ xX]\]/.test(parts[index]!.marker))
    : isHeading && active(index => parts[index]!.marker === heading);
  let number = 0;
  const changes: Replacement[] = [];
  for (const [index, line] of lines.entries()) {
    const part = parts[index]!;
    if (!line.text.trim() && selection.from !== selection.to) continue;
    if (command === 'indent') changes.push({ from: line.from, to: line.from, insert: '  ' });
    else if (command === 'outdent') {
      const count = /^(?:\t| {1,2})/.exec(line.text)?.[0].length ?? 0;
      if (count) changes.push({ from: line.from, to: line.from + count, insert: '' });
    } else if (command === 'blockquote') {
      const from = line.from + part.indent.length;
      const count = remove ? /^>[ \t]?/.exec(line.text.slice(part.indent.length))![0].length : 0;
      changes.push({ from, to: from + count, insert: remove ? '' : '> ' });
    } else if (command === 'paragraph') {
      changes.push({ from: line.from + part.indent.length, to: line.from + part.prefixLength, insert: '' });
    } else {
      number++;
      const prefix = remove ? '' : isHeading ? heading : command === 'ordered-list' ? `${number}. ` : command === 'task-list' ? '- [ ] ' : '- ';
      changes.push({ from: line.from + part.indent.length + part.quotes.length, to: line.from + part.prefixLength, insert: prefix });
    }
  }
  return edit(text, selection, changes);
}
function block(text: string, selection: DocumentSelection, content: string, innerFrom = 0, innerTo = content.length): DocumentEdit {
  const nl = newline(text);
  const before = text.slice(0, selection.from), after = text.slice(selection.to);
  const leading = before.length ? (before.endsWith(nl + nl) ? '' : before.endsWith(nl) ? nl : nl + nl) : '';
  const trailing = after.length ? (after.startsWith(nl + nl) ? '' : after.startsWith(nl) ? nl : nl + nl) : '';
  return replace(text, selection, leading + content + trailing, leading.length + innerFrom, leading.length + innerTo);
}
function fenced(text: string, selection: DocumentSelection, language: string, initial: string): DocumentEdit {
  if (!/^[A-Za-z0-9_+-]*$/.test(language)) fail('Code language must be a single language identifier.');
  const nl = newline(text), content = text.slice(selection.from, selection.to) || initial;
  const longest = Math.max(2, ...Array.from(content.matchAll(/`+/g), match => match[0].length));
  const fence = '`'.repeat(longest + 1), opening = fence + language + nl;
  return block(text, selection, opening + content + (content.endsWith('\n') ? '' : nl) + fence, opening.length, opening.length + content.length);
}
function destination(input: string | undefined, image: boolean): string {
  const value = input?.trim() ?? '';
  if (!value) fail('Enter a nonempty, single-line link URL.');
  for (const character of value) if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) fail('Enter a single-line link URL without control characters.');
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)?.[1]?.toLowerCase();
  if (scheme && !['https', 'http', ...(image ? [] : ['mailto'])].includes(scheme)) fail('Only HTTP(S), relative URLs and link mailto URLs are supported.');
  if (/^https?:\/*$/i.test(value) || /^\/\//.test(value)) fail('Enter a complete URL or a relative path, not an empty or protocol-relative URL.');
  return value.replace(/[\s<>\\()]/g, character => character === '(' ? '%28' : character === ')' ? '%29' : encodeURIComponent(character));
}
function wikiTarget(input: string | undefined, selectionText: string) {
  const value = (input?.trim() || selectionText.trim());
  if (!value || /[[\]\r\n]/.test(value) || value.split('|').length > 2 || !value.split('|')[0]!.trim()) fail('Enter a single note/object target, optionally followed by |label.');
  for (const character of value) if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) fail('A note/object target cannot contain control characters.');
  return value;
}
function flattenText(node: Node): string { return node.value ?? node.alt ?? (node.children ?? []).map(flattenText).join(''); }
function template(text: string, selection: DocumentSelection, spans: Span[], input: string | undefined): DocumentEdit {
  if (!input) fail('Enter a Markdown template.');
  let source = input;
  let variables: Record<string, string> = {};
  if (/^\s*\{\s*"/.test(input)) {
    let parsed: unknown;
    try { parsed = JSON.parse(input); } catch { fail('Template JSON must contain a template string and optional title/date/time strings.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('Template JSON must be an object.');
    const values = parsed as Record<string, unknown>;
    if (typeof values.template !== 'string') fail('Template JSON requires a template string.');
    source = values.template;
    for (const name of ['title', 'date', 'time']) if (values[name] !== undefined) {
      if (typeof values[name] !== 'string') fail(`Template variable ${name} must be a string.`);
      variables[name] = values[name] as string;
    }
  }
  const heading = spans.find(span => span.node.type === 'heading' && span.node.depth === 1);
  variables = { ...(heading ? { title: flattenText(heading.node) } : {}), ...variables };
  const expanded = source.replace(/\{\{\s*(title|date|time)\s*\}\}/g, (_, name: string) => {
    if (variables[name] === undefined) fail(`Template variable ${name} requires an explicit value in {template,title,date,time}.`);
    return variables[name]!;
  });
  if (!expanded) fail('The template is empty.');
  const normalized = expanded.replace(/\r\n|\r|\n/g, newline(text));
  return block(text, selection, normalized);
}
function clearFormatting(text: string, selection: DocumentSelection, spans: Span[]): DocumentEdit {
  if (selection.from === selection.to) fail('Select the text whose formatting should be cleared.');
  guard(text, selection, spans, true);
  const changes: Replacement[] = [];
  for (const span of spans) {
    const source = text.slice(span.from, span.to);
    if (['strong', 'emphasis', 'delete'].includes(span.node.type)) {
      const count = span.node.type === 'strong' || span.node.type === 'delete' ? 2 : 1;
      const inner = { from: span.from + count, to: span.to - count };
      if (selection.from <= span.from && selection.to >= span.to || selection.from === inner.from && selection.to === inner.to) {
        changes.push({ from: span.from, to: inner.from, insert: '' }, { from: inner.to, to: span.to, insert: '' });
      }
    } else if (span.node.type === 'inlineCode' && overlaps(selection, span)) {
      const ticks = /^`+/.exec(source)![0].length;
      const pad = source[ticks] === ' ' && source[source.length - ticks - 1] === ' ' && /[^ ]/.test(source.slice(ticks, -ticks)) ? 1 : 0;
      if (!(selection.from <= span.from && selection.to >= span.to || selection.from === span.from + ticks + pad && selection.to === span.to - ticks - pad)) fail('Select a complete inline code span to clear its formatting.');
      changes.push({ from: span.from, to: span.to, insert: span.node.value ?? '' });
    } else if (['link', 'image', 'linkReference', 'imageReference'].includes(span.node.type) && selection.from <= span.from && selection.to >= span.to) {
      if (span.node.type.startsWith('image')) changes.push({ from: span.from, to: span.to, insert: span.node.alt ?? '' });
      else {
        let depth = 1, end = span.from + 1;
        for (; end < span.to; end++) {
          if (escaped(text, end)) continue;
          if (text[end] === '[') depth++;
          if (text[end] === ']' && --depth === 0) break;
        }
        if (end < span.to) changes.push({ from: span.from, to: span.from + 1, insert: '' }, { from: end, to: span.to, insert: '' });
      }
    }
  }
  const syntax: [string, string][] = [['++', '++'], ['^', '^'], ['~', '~'], ['==', '=='], ...colors.map(color => [`=={${color}}`, '=='] as [string, string])];
  for (const family of ['color', 'font', 'size']) {
    const valid = family === 'color' ? '(?:red|orange|yellow|green|blue|purple|pink|#[0-9a-fA-F]{6})' : family === 'font' ? '(?:sans|serif|mono)' : '(?:small|normal|large|huge)';
    for (const match of text.slice(selection.from, selection.to).matchAll(new RegExp(`\\{${family}:${valid}\\}`, 'g'))) syntax.push([match[0], `{/${family}}`]);
    const before = text.slice(Math.max(0, selection.from - 24), selection.from);
    const match = new RegExp(`\\{${family}:${valid}\\}$`).exec(before);
    if (match) syntax.push([match[0], `{/${family}}`]);
  }
  // Scan only selected physical lines and respect the parser's code/HTML bounds.
  // Longer openers win (a colored highlight must not leave a literal {yellow}).
  syntax.sort((a, b) => b[0].length - a[0].length);
  for (const range of inlineRanges(text, selection)) {
    for (const [open, close] of syntax) {
      const pair = paired(text, range, open, close);
      if (pair) changes.push({ from: pair.outer.from, to: pair.inner.from, insert: '' }, { from: pair.inner.to, to: pair.outer.to, insert: '' });
    }
    for (let at = range.from; at < range.to; at++) {
      if (escaped(text, at) || spans.some(span => ['inlineCode', 'html'].includes(span.node.type) && at >= span.from && at < span.to)) continue;
      const token = syntax.find(([open]) => text.startsWith(open, at) && !(open === '~' && (text[at - 1] === '~' || text[at + 1] === '~')));
      if (!token) continue;
      const [open, close] = token;
      let end = text.indexOf(close, at + open.length);
      while (end >= 0 && end < range.to && (escaped(text, end) || close === '~' && (text[end - 1] === '~' || text[end + 1] === '~'))) end = text.indexOf(close, end + close.length);
      if (end < 0 || end + close.length > range.to || end === at + open.length) continue;
      changes.push({ from: at, to: at + open.length, insert: '' }, { from: end, to: end + close.length, insert: '' });
      at += open.length - 1;
    }
  }
  // Strip block markers only when the selection includes the whole line.
  for (const line of selectedLines(text, selection)) if (selection.from <= line.from && selection.to >= line.to) {
    const part = linePrefix(line.text);
    if (part.quotes || part.marker) changes.push({ from: line.from + part.indent.length, to: line.from + part.prefixLength, insert: '' });
  }
  const sorted = changes.sort((a, b) => a.from - b.from || b.to - a.to);
  const unique: Replacement[] = [];
  for (const change of sorted) {
    const previous = unique[unique.length - 1];
    if (previous && change.from < previous.to) {
      if (change.to <= previous.to) continue;
      if (!previous.insert && !change.insert) { previous.to = change.to; continue; }
      fail('Select complete formatting spans to clear formatting safely.');
    }
    unique.push(change);
  }
  return edit(text, selection, unique);
}

/** Apply one pure body-text transaction. Unknown or unsafe contexts throw rather than pretending success. */
export const applyDocumentCommand: DocumentCommand = (text, selection, command, input) => {
  validateSelection(text, selection);
  if (!documentCommands.some(item => item.id === command)) fail(`Unknown document command: ${command}`);
  const spans = spansOf(text);
  if (command === 'inline-code') return inlineCode(text, selection, spans);
  if (command === 'clear-formatting') return clearFormatting(text, selection, spans);
  if (command === 'paragraph' || command.startsWith('heading-') || ['ordered-list', 'unordered-list', 'task-list', 'blockquote', 'indent', 'outdent'].includes(command)) return paragraph(text, selection, spans, command);
  const markers: Record<string, string> = { bold: '**', italic: '*', bolditalic: '***', strike: '~~', underline: '++', superscript: '^', subscript: '~', 'formula-inline': '$', comment: '%%' };
  if (markers[command]) {
    if (command === 'formula-inline' && /[\r\n]/.test(text.slice(selection.from, selection.to))) fail('Select one line for an inline formula; use a block formula for multiple lines.');
    if (command === 'comment' && text.slice(selection.from, selection.to).includes('%%') && !paired(text, selection, '%%', '%%')) fail('Hidden comments cannot be nested.');
    return toggle(text, selection, spans, markers[command]!, markers[command]!, command === 'formula-inline' ? 'x^2' : command === 'comment' ? 'comment' : 'text');
  }
  if (command.startsWith('highlight-')) return toggle(text, selection, spans, `=={${command.slice(10)}}`, '==');
  if (['color', 'font', 'font-size'].includes(command)) {
    const value = input?.trim() ?? '';
    const valid = command === 'color' ? [...colors].includes(value as typeof colors[number]) || value === 'pink' || /^#[0-9a-fA-F]{6}$/.test(value) : (command === 'font' ? ['sans', 'serif', 'mono'] : ['small', 'normal', 'large', 'huge']).includes(value);
    if (!valid) fail(`Unsupported ${command} value; use one of the values listed in the command prompt.`);
    const family = command === 'font-size' ? 'size' : command;
    return toggle(text, selection, spans, `{${family}:${value}}`, `{/${family}}`);
  }
  guard(text, selection, spans, command === 'code-block' || command === 'mermaid' || command === 'formula-block');
  const selected = text.slice(selection.from, selection.to), nl = newline(text);
  if (command === 'link' || command === 'image') {
    if (/[\r\n]/.test(selected)) fail('Select one line for a link or image label.');
    const label = (selected || (command === 'image' ? 'image' : 'link')).replace(/([\\[\]])/g, '\\$1');
    const opening = command === 'image' ? '![' : '[';
    return replace(text, selection, `${opening}${label}](${destination(input, command === 'image')})`, opening.length, opening.length + label.length);
  }
  if (command === 'internal-link' || command === 'document-embed') {
    const target = wikiTarget(input, selected);
    const value = !target.includes('|') && selected && input?.trim() && command === 'internal-link' ? `${target}|${selected.replace(/[\[\]|\r\n]/g, ' ')}` : target;
    const prefix = command === 'document-embed' ? '![[' : '[[';
    return replace(text, selection, prefix + value + ']]', prefix.length, prefix.length + value.length);
  }
  if (command === 'code-block') return fenced(text, selection, input?.trim() ?? '', 'code');
  if (command === 'mermaid') return fenced(text, selection, 'mermaid', `flowchart TD${nl}  A[Start] --> B[End]`);
  if (command === 'horizontal-rule') return block(text, selection, '---');
  if (command === 'table') return block(text, selection, `| Column 1 | Column 2 |${nl}| --- | --- |${nl}| Cell 1 | Cell 2 |`, 2, 10);
  if (command === 'callout') {
    const [type = 'note', title = ''] = (input?.trim() || 'note').split('|');
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(type) || /[\r\n]/.test(title) || (input?.split('|').length ?? 0) > 2) fail('Callout input must be type|title on one line.');
    const opening = `> [!${type.toUpperCase()}]${title ? ` ${title}` : ''}${nl}`;
    const body = (selected || 'Note').split(/\r\n|\n|\r/).map(line => `> ${line}`).join(nl);
    return block(text, selection, opening + body, opening.length + 2, opening.length + body.length);
  }
  if (command === 'formula-block') {
    const content = selected || 'x^2';
    if (content.split(/\r?\n/).some(line => /^\s*\$\$\s*$/.test(line))) fail('A formula block cannot contain its own $$ delimiter.');
    return block(text, selection, `$$${nl}${content}${content.endsWith('\n') ? '' : nl}$$`, 2 + nl.length, 2 + nl.length + content.length);
  }
  if (command === 'footnote') {
    const identifiers = new Set(Array.from(text.matchAll(/\[\^([^\]\r\n]+)\]/g), match => match[1]!.toLowerCase()));
    let id = input?.trim() ?? '';
    if (!id) { let number = 1; while (identifiers.has(String(number))) number++; id = String(number); }
    if (!/^[A-Za-z0-9_-]+$/.test(id)) fail('Footnote IDs may contain letters, digits, underscores and hyphens.');
    if (identifiers.has(id.toLowerCase())) fail('This footnote ID is already in use; choose another ID.');
    const reference = `[^${id}]`;
    const body = (selected || 'Footnote').split(/\r\n|\n|\r/).map((line, index) => `${index ? '    ' : `[^${id}]: `}${line}`).join(nl);
    const changed = replace(text, selection, reference, reference.length, reference.length);
    const separator = changed.text.endsWith(nl + nl) ? '' : changed.text.endsWith(nl) ? nl : nl + nl;
    const result = changed.text + separator + body + nl;
    if (!spansOf(result).some(span => span.node.type === 'footnoteDefinition' && result.slice(span.from, span.to).startsWith(`[^${id}]:`))) fail('The trailing Markdown context would hide the footnote definition; close the surrounding fence or container first.');
    return { ...changed, text: result };
  }
  if (command === 'tag') {
    const value = (input?.trim() || selected.trim()).replace(/^#/, '');
    if (!/^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(value) || !/[\p{L}_-]/u.test(value)) fail('A tag needs a name without spaces; nested tags may use /.');
    const before = text[selection.from - 1], after = text[selection.to];
    if (before && /[\p{L}\p{N}_#]/u.test(before) || after && /[\p{L}\p{N}_]/u.test(after)) fail('Insert a tag at a word boundary.');
    return replace(text, selection, `#${value}`, 1, value.length + 1);
  }
  if (command === 'template') return template(text, selection, spans, input);
  return fail(`Unknown document command: ${command}`);
};
