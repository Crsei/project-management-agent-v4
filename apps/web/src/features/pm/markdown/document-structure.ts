import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { maskHiddenComments } from '../../../../../../packages/pm-markdown/syntax.ts';
import type { DocumentCommand, DocumentCommandDefinition, DocumentEdit, DocumentSelection } from './document-editing-types.ts';

interface Node {
  type: string;
  depth?: number;
  value?: string;
  alt?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
export interface DocumentBlock { from: number; to: number; kind: string }
export interface DocumentOutlineEntry { from: number; to: number; level: number; title: string }
interface LocatedBlock extends DocumentBlock { node: Node }
interface SourceLine { from: number; to: number; content: string; eol: string }
interface Cell { raw: string; from: number; to: number }
interface TableRow {
  prefix: string;
  before: string;
  after: string;
  cells: Cell[];
  eol: string;
  from: number;
  to: number;
}
interface Table { from: number; to: number; rows: TableRow[]; row: number; column: number; newline: string }
const parser = unified().use(remarkParse).use(remarkGfm);
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const alignmentMarkers: Record<string, string> = { 'table-align-left': ':---', 'table-align-center': ':---:', 'table-align-right': '---:', 'table-align-none': '---' };

export const structureCommands: DocumentCommandDefinition[] = [
  { id: 'table-row-add-before', label: '在上方插入表格行', labelEn: 'Insert table row above', group: 'table' },
  { id: 'table-row-add-after', label: '在下方插入表格行', labelEn: 'Insert table row below', group: 'table' },
  { id: 'table-row-delete', label: '删除表格行', labelEn: 'Delete table row', group: 'table' },
  { id: 'table-row-move-up', label: '上移表格行', labelEn: 'Move table row up', group: 'table' },
  { id: 'table-row-move-down', label: '下移表格行', labelEn: 'Move table row down', group: 'table' },
  { id: 'table-column-add-before', label: '在左侧插入表格列', labelEn: 'Insert table column left', group: 'table' },
  { id: 'table-column-add-after', label: '在右侧插入表格列', labelEn: 'Insert table column right', group: 'table' },
  { id: 'table-column-delete', label: '删除表格列', labelEn: 'Delete table column', group: 'table' },
  { id: 'table-column-move-left', label: '左移表格列', labelEn: 'Move table column left', group: 'table' },
  { id: 'table-column-move-right', label: '右移表格列', labelEn: 'Move table column right', group: 'table' },
  { id: 'table-align-left', label: '表格列左对齐', labelEn: 'Align table column left', group: 'table' },
  { id: 'table-align-center', label: '表格列居中', labelEn: 'Align table column center', group: 'table' },
  { id: 'table-align-right', label: '表格列右对齐', labelEn: 'Align table column right', group: 'table' },
  { id: 'table-align-none', label: '清除表格列对齐', labelEn: 'Clear table column alignment', group: 'table' },
  { id: 'table-sort-ascending', label: '按当前列升序排列正文行', labelEn: 'Sort body rows ascending by current column', group: 'table' },
  { id: 'table-sort-descending', label: '按当前列降序排列正文行', labelEn: 'Sort body rows descending by current column', group: 'table' },
  { id: 'callout-type', label: '修改 Callout 类型', labelEn: 'Change callout type', group: 'block', input: { label: '类型（NOTE / TIP / WARNING / RISK / DECISION 等）', labelEn: 'Type (NOTE / TIP / WARNING / RISK / DECISION, etc.)', initial: 'NOTE' } },
  { id: 'callout-title', label: '修改 Callout 标题', labelEn: 'Change callout title', group: 'block', input: { label: '标题（留空恢复默认标题）', labelEn: 'Title (empty for default title)' } },
  { id: 'callout-collapse', label: '修改 Callout 折叠', labelEn: 'Change callout folding', group: 'block', input: { label: 'toggle / collapsed / expanded / none', labelEn: 'toggle / collapsed / expanded / none', initial: 'toggle' } },
  { id: 'code-language', label: '修改代码块语言', labelEn: 'Change code block language', group: 'block', input: { label: '语言标识（留空清除）', labelEn: 'Language identifier (empty to clear)' } },
  { id: 'image-dimensions', label: '修改图片尺寸', labelEn: 'Change image dimensions', group: 'block', input: { label: '宽度或宽度x高度（1–4096，留空清除）', labelEn: 'Width or WIDTHxHEIGHT (1–4096, empty to clear)', initial: '640' } },
  { id: 'block-move-up', label: '上移内容块', labelEn: 'Move block up', group: 'block' },
  { id: 'block-move-down', label: '下移内容块', labelEn: 'Move block down', group: 'block' },
  { id: 'block-duplicate', label: '复制内容块', labelEn: 'Duplicate block', group: 'block' },
  { id: 'block-delete', label: '删除内容块', labelEn: 'Delete block', group: 'block' },
  { id: 'block-paragraph', label: '块转换为段落', labelEn: 'Convert block to paragraph', group: 'block' },
  { id: 'block-quote', label: '块转换为引用', labelEn: 'Convert block to quote', group: 'block' },
  { id: 'block-callout', label: '块转换为 Callout', labelEn: 'Convert block to callout', group: 'block', input: { label: '类型|标题（标题可省略）', labelEn: 'TYPE|Title (title optional)', initial: 'NOTE' } },
  { id: 'block-code', label: '块转换为代码', labelEn: 'Convert block to code', group: 'block', input: { label: '语言标识（可省略）', labelEn: 'Language identifier (optional)' } },
  { id: 'block-heading', label: '块转换为标题', labelEn: 'Convert block to heading', group: 'block', input: { label: '标题级别 1–6（仅单行内容）', labelEn: 'Heading level 1–6 (single-line content only)', initial: '2' } },
  { id: 'annotation-insert', label: '插入文内批注', labelEn: 'Insert inline document annotation', group: 'insert', input: { label: '单行批注（保存为 %% 批注 %%，不是评论线程）', labelEn: 'Single-line annotation (persisted as %% comment %%, not a thread)' } },
];

function offsets(node: Node): DocumentSelection | undefined {
  const from = node.position?.start.offset; const to = node.position?.end.offset;
  return from === undefined || to === undefined ? undefined : { from, to };
}
function allNodes(root: Node, type?: string): Node[] {
  const result: Node[] = [];
  function visit(node: Node) {
    if (!type || node.type === type) result.push(node);
    node.children?.forEach(visit);
  }
  visit(root);
  return result;
}
function parse(text: string): Node { return parser.parse(maskHiddenComments(text)) as Node; }
function lineStart(text: string, at: number): number { return at <= 0 ? 0 : text.lastIndexOf('\n', at - 1) + 1; }
function lineEnd(text: string, at: number): number {
  const end = text.indexOf('\n', at);
  return end < 0 ? text.length : end > 0 && text[end - 1] === '\r' ? end - 1 : end;
}
function lines(text: string, from: number, to: number): SourceLine[] {
  const result: SourceLine[] = [];
  let cursor = from;
  while (cursor <= to) {
    const end = Math.min(lineEnd(text, cursor), to);
    const eol = text.startsWith('\r\n', end) ? '\r\n' : text[end] === '\n' ? '\n' : '';
    result.push({ from: cursor, to: end, content: text.slice(cursor, end), eol });
    if (end >= to || !eol) break;
    cursor = end + eol.length;
  }
  return result;
}
function localNewline(text: string, from: number, to: number): string {
  return /\r\n|\n/.exec(text.slice(from, to))?.[0] ?? /\r\n|\n/.exec(text)?.[0] ?? '\n';
}
function contains(range: DocumentSelection, selection: DocumentSelection): boolean {
  return range.from <= selection.from && range.to >= selection.to;
}
function blocks(text: string, root: Node): LocatedBlock[] {
  return (root.children ?? []).flatMap(node => {
    const range = offsets(node);
    if (!range) return [];
    const from = lineStart(text, range.from); const to = lineEnd(text, Math.max(range.from, range.to - 1));
    let kind = node.type;
    if (kind === 'blockquote' && calloutMarker(text, node)) kind = 'callout';
    if (kind === 'paragraph' && node.children?.length === 1 && node.children[0]?.type === 'image') kind = 'image';
    return [{ from, to, kind, node }];
  });
}
/** Top-level structural ranges exclude trailing line endings and never split a fenced/list/quoted block. */
export function scanDocumentBlocks(text: string): DocumentBlock[] {
  return blocks(text, parse(text)).map(({ from, to, kind }) => ({ from, to, kind }));
}
function plain(node: Node): string { return node.value ?? node.alt ?? (node.children ?? []).map(plain).join(''); }
/** AST headings only: fenced examples and hidden annotations cannot enter the outline. */
export function scanDocumentOutline(text: string): DocumentOutlineEntry[] {
  return allNodes(parse(text), 'heading').flatMap(node => {
    const range = offsets(node);
    return range ? [{ ...range, level: node.depth ?? 1, title: plain(node) }] : [];
  });
}
function replace(text: string, from: number, to: number, value: string, selection?: DocumentSelection): DocumentEdit {
  if (text.slice(from, to) === value) throw new Error('This command would not change the document / 此操作不会改变文档');
  const next = text.slice(0, from) + value + text.slice(to);
  return { text: next, selection: selection ?? { from, to: from + value.length } };
}
function validateSelection(text: string, selection: DocumentSelection) {
  if (!Number.isInteger(selection.from) || !Number.isInteger(selection.to) || selection.from < 0 || selection.to < selection.from || selection.to > text.length) {
    throw new Error('Invalid document selection / 文档选区无效');
  }
}
function nearestNode(root: Node, selection: DocumentSelection, type: string): Node | undefined {
  return allNodes(root, type).filter(node => {
    const range = offsets(node); return range && contains(range, selection);
  }).sort((a, b) => (offsets(a)!.to - offsets(a)!.from) - (offsets(b)!.to - offsets(b)!.from))[0];
}
function escaped(text: string, at: number): boolean {
  let count = 0;
  while (at > 0 && text[--at] === '\\') count++;
  return count % 2 === 1;
}
function closingTicks(text: string, from: number, length: number): number {
  for (let cursor = from; cursor < text.length; cursor++) {
    if (text[cursor] !== '`') continue;
    let end = cursor + 1;
    while (text[end] === '`') end++;
    if (end - cursor === length) return end;
    cursor = end - 1;
  }
  return -1;
}
function splitRow(raw: string, visible: string, from: number, prefix: string, eol: string): TableRow {
  const pipes: number[] = [];
  for (let cursor = 0; cursor < visible.length; cursor++) {
    if (visible[cursor] === '\\') { cursor++; continue; }
    if (visible[cursor] === '`') {
      let end = cursor + 1;
      while (visible[end] === '`') end++;
      const close = closingTicks(visible, end, end - cursor);
      if (close >= 0) { cursor = close - 1; continue; }
      cursor = end - 1;
    } else if (visible[cursor] === '|') pipes.push(cursor);
  }
  const leading = pipes.length > 0 && !visible.slice(0, pipes[0]).trim();
  const trailing = pipes.length > (leading ? 1 : 0) && !visible.slice(pipes[pipes.length - 1]! + 1).trim();
  const start = leading ? pipes[0]! + 1 : 0;
  const end = trailing ? pipes[pipes.length - 1]! : raw.length;
  const separators = pipes.filter(at => at >= start && at < end);
  const cells: Cell[] = [];
  let cursor = start;
  for (const boundary of [...separators, end]) {
    cells.push({ raw: raw.slice(cursor, boundary), from: from + prefix.length + cursor, to: from + prefix.length + boundary });
    cursor = boundary + 1;
  }
  return { prefix, before: raw.slice(0, start), after: raw.slice(end), cells, eol, from, to: from + prefix.length + raw.length };
}
function locateTable(text: string, root: Node, selection: DocumentSelection): Table {
  const node = nearestNode(root, selection, 'table');
  if (!node) throw new Error('Place the selection in one GFM table / 请将选区放在一个 GFM 表格内');
  const range = offsets(node)!;
  const from = lineStart(text, range.from); const to = lineEnd(text, Math.max(range.from, range.to - 1));
  const sourceLines = lines(text, from, to); const masked = maskHiddenComments(text);
  const rowStarts = new Map((node.children ?? []).map(row => {
    const position = offsets(row)!; return [lineStart(text, position.from), position.from];
  }));
  const rows = sourceLines.map(line => {
    // Rows have AST offsets; only the delimiter line lacks a tableRow node.
    const contentFrom = rowStarts.get(line.from) ?? line.from + (/^(?:[ \t]*>[ \t]?)*[ \t]*/.exec(line.content)?.[0].length ?? 0);
    const prefix = text.slice(line.from, contentFrom);
    return splitRow(text.slice(contentFrom, line.to), masked.slice(contentFrom, line.to), line.from, prefix, line.eol);
  });
  const width = rows[0]?.cells.length ?? 0;
  if (!width || !rows[1] || rows[1].cells.length !== width || rows[1].cells.some(cell => !/^\s*:?-+:?\s*$/.test(cell.raw))) {
    throw new Error('The table delimiter does not match its header / 表格分隔行与表头不匹配');
  }
  if (rows.some(row => row.cells.length > width)) throw new Error('Table rows have extra cells; fix the source before structural editing / 表格行包含多余单元格，请先修正源码');
  // Missing GFM body cells are implicit empty cells. Make them explicit only when editing columns.
  let row = rows.findIndex(line => selection.from >= line.from && selection.from <= line.to);
  if (row < 0) row = rows.length - 1;
  const cells = rows[row]!.cells;
  let column = cells.findIndex(cell => selection.from >= cell.from && selection.from <= cell.to);
  if (column < 0) column = selection.from < cells[0]!.from ? 0 : cells.length - 1;
  return { from, to, rows, row, column, newline: localNewline(text, from, to) };
}
function renderRow(row: TableRow): string {
  return row.prefix + row.before + row.cells.map(cell => cell.raw).join('|') + row.after;
}
function renderRows(table: Table): string {
  return table.rows.map((row, index) => renderRow(row) + (index < table.rows.length - 1 ? row.eol || table.newline : '')).join('');
}
function paddedCell(raw: string, value: string): string {
  const match = /^(\s*)(.*?)(\s*)$/.exec(raw)!;
  return match[1] + value + match[3];
}
function tableEdit(text: string, root: Node, selection: DocumentSelection, command: string): DocumentEdit {
  const table = locateTable(text, root, selection); const { rows, row, column } = table;
  const reason = tableCommandReason(table, selection, command);
  if (reason) throw new Error(reason);
  const width = rows[0]!.cells.length;
  let targetRow = row; let targetColumn = column;
  if (command.startsWith('table-row-')) {
    if (command === 'table-row-add-before' || command === 'table-row-add-after') {
      const at = row < 2 ? 2 : row + (command.endsWith('after') ? 1 : 0);
      const template = rows[row < 2 ? 1 : row]!;
      rows.splice(at, 0, { ...template, cells: Array.from({ length: width }, () => ({ raw: ' ', from: 0, to: 0 })) });
      targetRow = at; targetColumn = 0;
    } else {
      if (command === 'table-row-delete') {
        rows.splice(row, 1); targetRow = Math.min(row, rows.length - 1);
      } else {
        const other = row + (command === 'table-row-move-up' ? -1 : 1);
        [rows[row], rows[other]] = [rows[other]!, rows[row]!]; targetRow = other;
      }
    }
  } else if (command.startsWith('table-sort-')) {
    const body = rows.slice(2).map((value, index) => ({ value, index }));
    body.sort((a, b) => {
      const order = collator.compare(a.value.cells[column]?.raw.trim() ?? '', b.value.cells[column]?.raw.trim() ?? '');
      return (command === 'table-sort-descending' ? -order : order) || a.index - b.index;
    });
    rows.splice(2, rows.length - 2, ...body.map(item => item.value));
    targetRow = row < 2 ? row : Math.max(2, rows.indexOf(body.find(item => item.index === row - 2)!.value));
  } else {
    const direction = command === 'table-column-move-left' ? -1 : 1;
    rows.forEach((item, index) => {
      if (command.startsWith('table-column-')) {
        while (item.cells.length < width) item.cells.push({ raw: ' ', from: 0, to: 0 });
      }
      if (command === 'table-column-add-before' || command === 'table-column-add-after') {
        const at = column + (command.endsWith('after') ? 1 : 0);
        item.cells.splice(at, 0, { raw: index === 1 ? ' --- ' : ' ', from: 0, to: 0 }); targetColumn = at;
      } else if (command === 'table-column-delete') {
        item.cells.splice(column, 1); targetColumn = Math.min(column, width - 2);
        // Keep a formerly multi-column pipe-less table valid after deleting down to one column.
        if (width === 2 && !item.before.includes('|') && !item.after.includes('|')) { item.before = '|'; item.after = '|'; }
      } else if (command.startsWith('table-column-move-')) {
        [item.cells[column], item.cells[column + direction]] = [item.cells[column + direction]!, item.cells[column]!]; targetColumn = column + direction;
      } else if (index === 1) {
        const marker = alignmentMarkers[command];
        if (!marker) throw new Error(`Unknown table command: ${command}`);
        item.cells[column]!.raw = paddedCell(item.cells[column]!.raw, marker);
      }
    });
  }
  const replacement = renderRows(table);
  let caret = table.from;
  for (let index = 0; index < targetRow; index++) caret += renderRow(rows[index]!).length + (rows[index]!.eol || table.newline).length;
  const current = rows[targetRow]!;
  caret += current.prefix.length + current.before.length;
  for (let index = 0; index < targetColumn; index++) caret += current.cells[index]!.raw.length + 1;
  caret += /^\s*/.exec(current.cells[targetColumn]?.raw ?? '')![0].length;
  return replace(text, table.from, table.to, replacement, { from: caret, to: caret });
}

function calloutMarker(text: string, node: Node) {
  const range = offsets(node);
  if (!range) return undefined;
  const from = lineStart(text, range.from); const to = lineEnd(text, range.from);
  const match = /^([ \t]*(?:>[ \t]?)+)\[!([A-Za-z][\w-]*)\]([+-]?)(?:[ \t]+([^\r\n]*))?$/.exec(text.slice(from, to));
  return match ? { from, to, prefix: match[1]!, type: match[2]!, collapse: match[3]!, title: match[4] ?? '' } : undefined;
}
function calloutEdit(text: string, root: Node, selection: DocumentSelection, command: string, input?: string): DocumentEdit {
  const node = allNodes(root, 'blockquote').filter(item => {
    const range = offsets(item); return range && contains(range, selection) && calloutMarker(text, item);
  }).sort((a, b) => offsets(b)!.from - offsets(a)!.from)[0];
  const marker = node && calloutMarker(text, node);
  if (!marker) throw new Error('Place the selection in a callout / 请将选区放在 Callout 内');
  let { type, title, collapse } = marker;
  if (command === 'callout-type') {
    type = input?.trim() ?? '';
    if (!/^[A-Za-z][\w-]{0,31}$/.test(type)) throw new Error('Callout type must be a 1–32 character identifier / Callout 类型须为 1–32 位标识符');
    type = type.toUpperCase();
  } else if (command === 'callout-title') {
    title = input?.trim() ?? '';
    if (/[\r\n]/.test(title)) throw new Error('Callout titles must fit on one line / Callout 标题只能有一行');
  } else {
    const state = input?.trim().toLowerCase() || 'toggle';
    if (!['toggle', 'collapsed', 'expanded', 'none'].includes(state)) throw new Error('Use toggle, collapsed, expanded, or none / 请输入 toggle、collapsed、expanded 或 none');
    collapse = state === 'toggle' ? collapse === '-' ? '+' : '-' : state === 'collapsed' ? '-' : state === 'expanded' ? '+' : '';
  }
  return replace(text, marker.from, marker.to, `${marker.prefix}[!${type}]${collapse}${title ? ` ${title}` : ''}`);
}
function language(input?: string): string {
  const value = input?.trim() ?? '';
  if (!/^[\w.+#/-]*$/.test(value)) throw new Error('Use a language identifier without spaces or fence characters / 语言标识不能包含空格或围栏字符');
  return value;
}
function codeLanguageEdit(text: string, root: Node, selection: DocumentSelection, input?: string): DocumentEdit {
  const node = nearestNode(root, selection, 'code');
  const range = node && offsets(node);
  if (!range) throw new Error('Place the selection in a fenced code block / 请将选区放在围栏代码块内');
  const end = lineEnd(text, range.from);
  const opening = /^(`{3,}|~{3,})([ \t]*)([^ \t]*)(.*)$/.exec(text.slice(range.from, end));
  if (!opening) throw new Error('Indented code has no language marker; use a fenced code block / 缩进代码没有语言标识，请先转换为围栏代码块');
  const value = language(input);
  if (!value && opening[4]!.trim()) throw new Error('Remove fence metadata in source before clearing its language / 清除语言前请先在源码中移除围栏元数据');
  return replace(text, range.from, end, opening[1] + opening[2]! + value + opening[4]!);
}
function locateImage(text: string, root: Node, selection: DocumentSelection): { from: number; to: number; inTable: boolean } {
  const node = nearestNode(root, selection, 'image') ?? nearestNode(root, selection, 'imageReference');
  const range = node && offsets(node);
  if (!range) throw new Error('Place the selection inside a Markdown image / 请将选区放在 Markdown 图片内');
  let close = -1; let depth = 1;
  for (let at = range.from + 2; at < range.to; at++) {
    if (escaped(text, at)) continue;
    if (text[at] === '[') depth++;
    if (text[at] === ']' && --depth === 0) { close = at; break; }
  }
  if (close < 0) throw new Error('Cannot locate the image alt text / 无法定位图片替代文字');
  if (node!.type === 'imageReference' && !/^\[[^\]]+\]$/.test(text.slice(close + 1, range.to))) {
    throw new Error('Use an inline image or an explicit reference label before resizing / 调整尺寸前请使用行内图片或显式引用标签');
  }
  return { from: range.from + 2, to: close, inTable: Boolean(nearestNode(root, range, 'table')) };
}
function imageEdit(text: string, root: Node, selection: DocumentSelection, input?: string): DocumentEdit {
  const { from: altFrom, to: close, inTable } = locateImage(text, root, selection);
  const value = input?.trim().toLowerCase() ?? '';
  if (value && (!/^\d{1,4}(?:x\d{1,4})?$/.test(value) || value.split('x').some(part => Number(part) < 1 || Number(part) > 4096))) {
    throw new Error('Image dimensions must be WIDTH or WIDTHxHEIGHT, each 1–4096 / 图片尺寸须为宽度或宽度x高度，每项 1–4096');
  }
  const alt = text.slice(altFrom, close);
  const suffix = /\|\d{1,4}(?:x\d{1,4})?$/.exec(alt);
  // GFM table cells require an escaped dimension separator; outside tables an escaped pipe is literal.
  const escapedSuffix = suffix ? escaped(alt, suffix.index) : false;
  const hasSuffix = suffix && (inTable || !escapedSuffix) && suffix[0].slice(1).split('x').every(part => Number(part) >= 1 && Number(part) <= 4096);
  const plainAlt = hasSuffix && suffix ? alt.slice(0, suffix.index - (escapedSuffix ? 1 : 0)) : alt;
  return replace(text, altFrom, close, plainAlt + (value ? `${inTable ? '\\|' : '|'}${value}` : ''));
}

function prose(text: string, block: LocatedBlock): string {
  const raw = text.slice(block.from, block.to); const newline = localNewline(text, block.from, block.to);
  if (block.node.type === 'paragraph') return raw;
  if (block.node.type === 'heading') {
    if (/^[ \t]{0,3}#{1,6}(?:[ \t]|$)/.test(raw)) return raw.replace(/^[ \t]{0,3}#{1,6}[ \t]*/, '').replace(/[ \t]+#+[ \t]*$/, '');
    return raw.replace(/\r?\n[ \t]*[=-]+[ \t]*$/, '');
  }
  if (block.node.type === 'blockquote') {
    const content = raw.split(/\r?\n/).map(line => line.replace(/^[ \t]{0,3}>[ \t]?/, ''));
    const marker = /^\[![A-Za-z][\w-]*\][+-]?(?:[ \t]+(.*))?$/.exec(content[0] ?? '');
    if (marker) {
      if (marker[1]) content[0] = marker[1];
      else content.shift();
    }
    return content.join(newline);
  }
  if (block.node.type === 'code') return (block.node.value ?? '').replace(/\r\n|\r|\n/g, newline);
  throw new Error('Convert only paragraphs, headings, quotes, callouts, or code blocks / 仅支持转换段落、标题、引用、Callout 或代码块');
}
function blockEdit(text: string, root: Node, selection: DocumentSelection, command: string, input?: string): DocumentEdit {
  const documentBlocks = blocks(text, root);
  const index = documentBlocks.findIndex(block => contains(block, selection));
  const block = documentBlocks[index];
  if (!block) throw new Error('Select one content block, not a gap or multiple blocks / 请只选择一个内容块，不能选择空白间隔或跨越多个块');
  const raw = text.slice(block.from, block.to); const newline = localNewline(text, block.from, block.to);
  if (command === 'block-delete') return replace(text, block.from, block.to, '', { from: block.from, to: block.from });
  if (command === 'block-duplicate') {
    const separator = newline + newline;
    return replace(text, block.from, block.to, raw + separator + raw, { from: block.from + raw.length + separator.length, to: block.from + raw.length + separator.length + raw.length });
  }
  if (command === 'block-move-up' || command === 'block-move-down') {
    const other = documentBlocks[index + (command.endsWith('up') ? -1 : 1)];
    if (!other) throw new Error('The block is already at this document boundary / 内容块已在文档边界');
    const first = block.from < other.from ? block : other; const second = first === block ? other : block;
    const gap = text.slice(first.to, second.from);
    const firstRaw = text.slice(first.from, first.to); const secondRaw = text.slice(second.from, second.to);
    const movedFrom = first === block ? first.from + secondRaw.length + gap.length : first.from;
    return replace(text, first.from, second.to, secondRaw + gap + firstRaw, { from: movedFrom + selection.from - block.from, to: movedFrom + selection.to - block.from });
  }
  if (command === 'block-callout' && block.kind === 'callout') throw new Error('This is already a callout; use its type/title/folding commands / 此块已经是 Callout，请使用类型、标题或折叠命令');
  // Wrapping unsupported compound blocks as code is lossless; other conversions are prose-only.
  const content = command === 'block-code' && !['paragraph', 'heading', 'blockquote', 'code'].includes(block.node.type) ? raw : prose(text, block);
  if (!content.trim()) throw new Error('This block has no content to convert / 此内容块没有可转换的正文');
  let replacement: string;
  if (command === 'block-paragraph') replacement = content;
  else if (command === 'block-quote') replacement = content.split(/\r?\n/).map(line => line ? `> ${line}` : '>').join(newline);
  else if (command === 'block-callout') {
    const [type = 'NOTE', ...titleParts] = (input?.trim() || 'NOTE').split('|');
    const title = titleParts.join('|').trim();
    if (!/^[A-Za-z][\w-]{0,31}$/.test(type) || /[\r\n]/.test(title)) throw new Error('Use TYPE|Title with a single-line title / 请使用 类型|标题，标题不能换行');
    replacement = `> [!${type.toUpperCase()}]${title ? ` ${title}` : ''}${newline}${content.split(/\r?\n/).map(line => line ? `> ${line}` : '>').join(newline)}`;
  } else if (command === 'block-heading') {
    const level = input?.trim() || '2';
    if (!/^[1-6]$/.test(level) || /[\r\n]/.test(content)) throw new Error('A heading requires single-line content and level 1–6 / 标题要求单行正文与 1–6 级别');
    replacement = `${'#'.repeat(Number(level))} ${content}`;
  } else if (command === 'block-code') {
    let fenceLength = 3;
    for (const match of content.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = '`'.repeat(fenceLength);
    replacement = `${fence}${language(input)}${newline}${content}${content.endsWith(newline) ? '' : newline}${fence}`;
  } else throw new Error(`Unknown block command: ${command}`);
  return replace(text, block.from, block.to, replacement);
}
function annotationPositionReason(text: string, root: Node, at: number): string | null {
  const literal = allNodes(root).some(node => {
    const range = offsets(node);
    if (!range) return false;
    if (node.type === 'code' || node.type === 'html') return range.from <= at && range.to >= at;
    return ['inlineCode', 'image', 'imageReference', 'link', 'linkReference'].includes(node.type) && range.from < at && range.to > at;
  });
  if (literal) return 'Annotations cannot be inserted inside code, HTML, links, or images / 不能在代码、HTML、链接或图片内部插入批注';
  const masked = maskHiddenComments(text);
  let opening = -1;
  for (const match of text.matchAll(/%%/g)) {
    const index = match.index!;
    if (escaped(text, index) || masked[index] === text[index]) continue;
    if (opening < 0) opening = index;
    else {
      if (opening < at && at < index + 2) return 'Move outside the existing annotation / 请移到现有批注之外';
      opening = -1;
    }
  }
  if (opening >= 0 && at > opening) return 'Move outside the existing annotation / 请移到现有批注之外';
  return null;
}
function annotationEdit(text: string, root: Node, selection: DocumentSelection, input?: string): DocumentEdit {
  const value = input?.trim() ?? '';
  if (!value || /%%|[\r\n]/.test(value)) throw new Error('Enter a single-line annotation without %% delimiters / 请输入不含 %% 分隔符的单行批注');
  const at = selection.to; const reason = annotationPositionReason(text, root, at);
  if (reason) throw new Error(reason);
  const before = at > 0 && !/\s/.test(text[at - 1]!) ? ' ' : '';
  const after = at < text.length && !/\s/.test(text[at]!) ? ' ' : '';
  const insertion = `${before}%% ${value} %%${after}`;
  return replace(text, at, at, insertion, { from: at + before.length + 3, to: at + before.length + 3 + value.length });
}

function tableCommandReason(table: Table, selection: DocumentSelection, command: string): string | null {
  const { rows, row, column } = table; const width = rows[0]!.cells.length;
  if (command.startsWith('table-row-')) {
    if (selection.to > rows[row]!.to) return 'Select a single table row / 请只选择一个表格行';
    if (command === 'table-row-add-after') return null;
    if (command === 'table-row-add-before') return row < 2 ? 'A body row cannot precede the header / 正文行不能放在表头之前' : null;
    if (row < 2) return 'The table header and delimiter cannot be deleted or moved / 不能删除或移动表头与分隔行';
    if ((command === 'table-row-move-up' && row === 2) || (command === 'table-row-move-down' && row === rows.length - 1)) return 'The table row is already at this boundary / 表格行已在边界';
  } else if (command === 'table-column-delete' && width === 1) {
    return 'A table must retain at least one column / 表格至少需要保留一列';
  } else if ((command === 'table-column-move-left' && column === 0) || (command === 'table-column-move-right' && column === width - 1)) {
    return 'The table column is already at this boundary / 表格列已在边界';
  } else if (command.startsWith('table-sort-')) {
    if (rows.length < 4) return 'Sorting requires at least two body rows / 至少需要两行表格正文才能排序';
    const direction = command === 'table-sort-descending' ? -1 : 1;
    if (rows.slice(3).every((item, index) => direction * collator.compare(rows[index + 2]!.cells[column]?.raw.trim() ?? '', item.cells[column]?.raw.trim() ?? '') <= 0)) return 'Body rows already have this sort order / 正文行已按此顺序排列';
  } else if (alignmentMarkers[command] === rows[1]!.cells[column]!.raw.trim()) {
    return 'This column already has this alignment / 此列已采用该对齐方式';
  }
  return null;
}
function structureReason(text: string, selection: DocumentSelection, command: string, root: Node, documentBlocks: LocatedBlock[], table: Table | string): string | null {
  if (command.startsWith('table-')) return typeof table === 'string' ? table : tableCommandReason(table, selection, command);
  if (command.startsWith('callout-')) {
    return allNodes(root, 'blockquote').some(node => {
      const range = offsets(node); return range && contains(range, selection) && calloutMarker(text, node);
    }) ? null : 'Place the selection in a callout / 请将选区放在 Callout 内';
  }
  if (command === 'code-language') {
    const node = nearestNode(root, selection, 'code'); const range = node && offsets(node);
    if (!range) return 'Place the selection in a fenced code block / 请将选区放在围栏代码块内';
    return /^(`{3,}|~{3,})/.test(text.slice(range.from, lineEnd(text, range.from))) ? null : 'Indented code has no language marker / 缩进代码没有语言标识';
  }
  if (command === 'image-dimensions') {
    try { locateImage(text, root, selection); return null; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }
  if (command === 'annotation-insert') return annotationPositionReason(text, root, selection.to);
  const index = documentBlocks.findIndex(block => contains(block, selection)); const block = documentBlocks[index];
  if (!block) return 'Select one content block, not a gap or multiple blocks / 请只选择一个内容块，不能选择空白间隔或跨越多个块';
  if ((command === 'block-move-up' && index === 0) || (command === 'block-move-down' && index === documentBlocks.length - 1)) return 'The block is already at this document boundary / 内容块已在文档边界';
  if (['block-move-up', 'block-move-down', 'block-duplicate', 'block-delete', 'block-code'].includes(command)) return null;
  if (command === 'block-callout' && block.kind === 'callout') return 'This is already a callout; use its type/title/folding commands / 此块已经是 Callout，请使用类型、标题或折叠命令';
  if (!['paragraph', 'heading', 'blockquote', 'code'].includes(block.node.type)) return 'Convert only paragraphs, headings, quotes, callouts, or code blocks / 仅支持转换段落、标题、引用、Callout 或代码块';
  const content = prose(text, block);
  if (!content.trim()) return 'This block has no content to convert / 此内容块没有可转换的正文';
  if (command === 'block-paragraph' && block.node.type === 'paragraph') return 'This block is already a paragraph / 此块已经是段落';
  if (command === 'block-quote' && block.node.type === 'blockquote' && block.kind !== 'callout') return 'This block is already a quote / 此块已经是引用';
  if (command === 'block-heading' && /[\r\n]/.test(content)) return 'Headings require single-line content / 标题要求单行正文';
  return null;
}
/** All contextual menu reasons share one AST/table scan; input values are validated when applied. */
export function documentStructureCommandReasons(text: string, selection: DocumentSelection): Record<string, string | null> {
  const reasons: Record<string, string | null> = {};
  try { validateSelection(text, selection); }
  catch (error) {
    for (const command of structureCommands) reasons[command.id] = error instanceof Error ? error.message : String(error);
    return reasons;
  }
  const root = parse(text); const documentBlocks = blocks(text, root);
  let table: Table | string;
  try { table = locateTable(text, root, selection); }
  catch (error) { table = error instanceof Error ? error.message : String(error); }
  for (const command of structureCommands) reasons[command.id] = structureReason(text, selection, command.id, root, documentBlocks, table);
  return reasons;
}
/** null means the current context is applicable, not that an arbitrary input value is valid. */
export function documentStructureCommandReason(text: string, selection: DocumentSelection, command: string): string | null {
  if (!structureCommands.some(definition => definition.id === command)) return `Unknown structure command / 未知结构命令: ${command}`;
  return documentStructureCommandReasons(text, selection)[command]!;
}

/** Body-only UTF-16 transaction. Unsupported contexts and boundary/no-change actions throw. */
export const applyStructureCommand: DocumentCommand = (text, selection, command, input) => {
  validateSelection(text, selection);
  if (!structureCommands.some(definition => definition.id === command)) throw new Error(`Unknown structure command / 未知结构命令: ${command}`);
  const root = parse(text);
  if (command.startsWith('table-')) return tableEdit(text, root, selection, command);
  if (command.startsWith('callout-')) return calloutEdit(text, root, selection, command, input);
  if (command === 'code-language') return codeLanguageEdit(text, root, selection, input);
  if (command === 'image-dimensions') return imageEdit(text, root, selection, input);
  if (command.startsWith('block-')) return blockEdit(text, root, selection, command, input);
  return annotationEdit(text, root, selection, input);
};
