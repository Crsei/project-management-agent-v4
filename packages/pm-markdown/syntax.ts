import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { decodeString } from 'micromark-util-decode-string';

export interface SyntaxNode {
  type: string;
  value?: string;
  alt?: string;
  url?: string;
  depth?: number;
  checked?: boolean | null;
  children?: SyntaxNode[];
  position?: { start: { line: number; offset?: number }; end: { line: number; offset?: number } };
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}
const syntaxParser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath);
const palette: Record<string, true> = { yellow: true, green: true, blue: true, purple: true, orange: true, red: true };
const colorValues: Record<string, string> = { yellow: '#9a6700', orange: '#c2410c', green: '#16803d', blue: '#2563eb', purple: '#9333ea', pink: '#db2777', red: '#dc2626' };

function escaped(source: string, index: number): boolean {
  let count = 0;
  while (index > 0 && source[--index] === '\\') count++;
  return count % 2 === 1;
}

/** Hide comments without moving a single UTF-16 offset or original source line. Code is literal. */
export function maskHiddenComments(source: string): string {
  if (!source.includes('%%')) return source;
  const protectedRanges: [number, number][] = [];
  function collect(node: SyntaxNode) {
    if (['code', 'inlineCode', 'math', 'inlineMath'].includes(node.type)) {
      const start = node.position?.start.offset; const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) protectedRanges.push([start, end]);
      return;
    }
    node.children?.forEach(collect);
  }
  collect(syntaxParser.parse(source) as SyntaxNode);
  let cursor = 0; let range = 0; let result = '';
  while (cursor < source.length) {
    while (range < protectedRanges.length && protectedRanges[range]![1] <= cursor) range++;
    const protectedRange = protectedRanges[range];
    if (protectedRange && cursor >= protectedRange[0]) {
      result += source.slice(cursor, protectedRange[1]); cursor = protectedRange[1]; continue;
    }
    if (source.startsWith('%%', cursor) && !escaped(source, cursor)) {
      let end = cursor + 2;
      while (end < source.length && (!source.startsWith('%%', end) || escaped(source, end))) end++;
      end = Math.min(source.length, end + 2);
      result += source.slice(cursor, end).replace(/[^\r\n]/g, ' '); cursor = end;
    } else { result += source[cursor]; cursor++; }
  }
  return result;
}

export function imageDimensions(alt: string, rawSource?: string, inTable = false): { alt: string; width?: number; height?: number } {
  const match = /^(.*)\|(\d{1,4})(?:x(\d{1,4}))?$/.exec(alt);
  if (!match) return { alt };
  if (rawSource?.startsWith('![')) {
    let depth = 0; let end = 2;
    for (; end < rawSource.length; end++) {
      if (escaped(rawSource, end)) continue;
      if (rawSource[end] === '[') depth++;
      if (rawSource[end] === ']') { if (depth === 0) break; depth--; }
    }
    const rawAlt = rawSource.slice(2, end); const suffix = /\|(\d{1,4})(?:x(\d{1,4}))?$/.exec(rawAlt);
    if (!suffix || (escaped(rawAlt, suffix.index) && !inTable)) return { alt };
  }
  const width = Number(match[2]); const height = match[3] === undefined ? undefined : Number(match[3]);
  if (width < 1 || width > 4096 || (height !== undefined && (height < 1 || height > 4096))) return { alt };
  return { alt: match[1]!, width, ...(height === undefined ? {} : { height }) };
}

function styled(name: string, value: string, children: SyntaxNode[]): SyntaxNode | undefined {
  if (name === 'highlight' && Object.hasOwn(palette, value)) return { type: 'workspaceStyle', children, data: { hName: 'mark', hProperties: { className: `md-highlight md-highlight-${value}` } } };
  if (name === 'color' && (Object.hasOwn(colorValues, value) || /^#[0-9a-f]{6}$/i.test(value))) return { type: 'workspaceStyle', children, data: { hName: 'span', hProperties: { style: `color:${colorValues[value] ?? value}` } } };
  if (name === 'font' && ['sans', 'serif', 'mono'].includes(value)) return { type: 'workspaceStyle', children, data: { hName: 'span', hProperties: { className: `md-font-${value}` } } };
  if (name === 'size' && ['small', 'normal', 'large', 'huge'].includes(value)) return { type: 'workspaceStyle', children, data: { hName: 'span', hProperties: { className: `md-size-${value}` } } };
  return undefined;
}

// AST text has already decoded Markdown backslash escapes. Preserve escaped extension markers
// before parsing, rather than interpreting a literal escaped marker as formatting.
function extensionText(node: SyntaxNode, source: string, markers: Record<string, string>): string {
  const start = node.position?.start.offset; const end = node.position?.end.offset;
  const raw = start === undefined || end === undefined ? '' : source.slice(start, end);
  const value = node.value ?? '';
  if (!raw.includes('\\')) return value;
  const lines = value.split('\n'); const rawLines = raw.split(/\r?\n/);
  for (let line = 0; line < lines.length; line++) {
    const rawLine = rawLines[line] ?? ''; const decoded = decodeString(rawLine); const visible = lines[line]!;
    const trim = decoded.indexOf(visible);
    // Container prefixes are absent from AST text. If the source cannot be aligned, keep
    // this text literal rather than accidentally activate an explicitly escaped marker.
    if (trim < 0) return value.replace(/[=+^~{\[]/g, character => markers[character]!);
    const replacements: { index: number; value: string }[] = [];
    for (const match of rawLine.matchAll(/\\([\\!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g)) {
      const replacement = markers[match[1]!];
      if (!replacement) continue;
      const index = decodeString(rawLine.slice(0, match.index)).length - trim;
      if (index >= 0 && index < visible.length) replacements.push({ index, value: replacement });
    }
    for (const replacement of replacements.reverse()) lines[line] = `${lines[line]!.slice(0, replacement.index)}${replacement.value}${lines[line]!.slice(replacement.index + 1)}`;
  }
  return lines.join('\n');
}
function restore(value: string, markers: Record<string, string>): string {
  for (const [literal, marker] of Object.entries(markers)) value = value.split(marker).join(literal);
  return value;
}

function inlineStyles(value: string, markers: Record<string, string>, depth = 0, allowReferences = true): SyntaxNode[] {
  if (depth > 12) return [{ type: 'text', value: restore(value, markers) }];
  const pattern = /==(?:(?:\{(yellow|green|blue|purple|orange|red)\}))?([^\n]+?)==|\+\+([^\n]+?)\+\+|(?<!\^)\^([^\s^](?:[^\n^]*?[^\s^])?)\^(?!\^)|(?<!~)~([^\s~](?:[^\n~]*?[^\s~])?)~(?!~)|\{(color|font|size):([^{}\n]+)\}([^\n]+?)\{\/\6\}|(!?)\[\[([^\]\n]+)\]\]/g;
  const nodes: SyntaxNode[] = []; let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    let node: SyntaxNode | undefined;
    if (match[2] !== undefined) node = styled('highlight', match[1] ?? 'yellow', inlineStyles(match[2], markers, depth + 1, allowReferences));
    else if (match[3] !== undefined) node = { type: 'workspaceStyle', children: inlineStyles(match[3], markers, depth + 1, allowReferences), data: { hName: 'u' } };
    else if (match[4] !== undefined) node = { type: 'workspaceStyle', children: inlineStyles(match[4], markers, depth + 1, allowReferences), data: { hName: 'sup' } };
    if (!node && match[0].startsWith('~')) node = { type: 'workspaceStyle', children: inlineStyles(match[5]!, markers, depth + 1, allowReferences), data: { hName: 'sub' } };
    if (!node && match[6]) node = styled(match[6], match[7]!, inlineStyles(match[8]!, markers, depth + 1, allowReferences));
    if (!node && match[10] && allowReferences) {
      const target = wikiTarget(match[10]); const children = inlineStyles(target.label || match[10], markers, depth + 1, false);
      if (target.id || target.fragment) node = match[9] ? { type: 'workspaceEmbed', children, data: { hName: 'section', hProperties: { 'data-document-embed': match[10] } } } : { type: 'link', url: `#entity:${encodeURIComponent(match[10])}`, children, data: { hProperties: { 'data-entity-target': match[10] } } };
    }
    if (!node) continue;
    if (match.index! > cursor) nodes.push({ type: 'text', value: restore(value.slice(cursor, match.index), markers) });
    nodes.push(node); cursor = match.index! + match[0].length;
  }
  if (cursor < value.length) nodes.push({ type: 'text', value: restore(value.slice(cursor), markers) });
  return nodes;
}

/** Only this fixed extension vocabulary can produce DOM styles; never parse raw HTML. */
export function enhanceMarkdownTree(tree: SyntaxNode, source: string): void {
  const occupied = [source];
  function collectValues(node: SyntaxNode) {
    if (node.value) occupied.push(node.value);
    if (node.alt) occupied.push(node.alt);
    node.children?.forEach(collectValues);
  }
  collectValues(tree);
  let escapePrefix = '\uE000';
  while (occupied.some(value => value.includes(escapePrefix))) escapePrefix += '\uE000';
  const markers: Record<string, string> = Object.fromEntries(['=', '+', '^', '~', '{', '['].map((character, index) => [character, `${escapePrefix}${index}\uE001`]));
  function visit(node: SyntaxNode, inTable = false) {
    if (node.type === 'image') {
      const start = node.position?.start.offset; const end = node.position?.end.offset;
      const dimensions = imageDimensions(node.alt ?? '', start === undefined || end === undefined ? undefined : source.slice(start, end), inTable);
      node.alt = dimensions.alt;
      if (dimensions.width) node.data = { ...node.data, hProperties: { ...node.data?.hProperties, width: dimensions.width, ...(dimensions.height ? { height: dimensions.height } : {}) } };
      return;
    }
    if (!node.children || ['code', 'inlineCode', 'html', 'math', 'inlineMath'].includes(node.type)) return;
    if (node.type === 'paragraph') {
      const start = node.position?.start.offset; const end = node.position?.end.offset;
      const raw = start === undefined || end === undefined ? '' : source.slice(start, end);
      const marker = /(?:^|\s)\^([\w-]+)[ \t]*$/.exec(raw); const last = node.children.at(-1);
      if (marker && last?.type === 'text' && last.value?.trimEnd().endsWith(`^${marker[1]}`)) {
        last.value = last.value.slice(0, last.value.lastIndexOf('^')).trimEnd();
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, 'data-block-id': marker[1] } };
      }
    }
    node.children.forEach(child => visit(child, inTable || node.type === 'table'));
    if (!['paragraph', 'heading', 'emphasis', 'strong', 'delete', 'link', 'tableCell'].includes(node.type)) return;
    const original = node.children;
    const value = original.map(child => child.type === 'text' ? extensionText(child, source, markers) : '').join('');
    // Preserve existing inline Markdown nodes (strong, links, code, etc.) while allowing an
    // extension to wrap them. Choose a separator absent from the actual document text.
    let separator = '\uE100';
    while (value.includes(separator)) separator += '\uE100';
    const combined = original.map((child, index) => child.type === 'text' ? extensionText(child, source, markers) : `${separator}${index}\uE101`).join('');
    function expand(child: SyntaxNode): SyntaxNode[] {
      if (child.children) { child.children = child.children.flatMap(expand); return [child]; }
      if (child.type !== 'text' || !child.value?.includes(separator)) return [child];
      const parts: SyntaxNode[] = []; let cursor = 0;
      while (cursor < child.value.length) {
        const start = child.value.indexOf(separator, cursor);
        if (start < 0) { parts.push({ type: 'text', value: child.value.slice(cursor) }); break; }
        if (start > cursor) parts.push({ type: 'text', value: child.value.slice(cursor, start) });
        const end = child.value.indexOf('\uE101', start + separator.length);
        const item = original[Number(child.value.slice(start + separator.length, end))];
        if (end < 0 || !item) { parts.push({ type: 'text', value: child.value.slice(start) }); break; }
        parts.push(item); cursor = end + 1;
      }
      return parts;
    }
    node.children = inlineStyles(combined, markers, 0, node.type !== 'link').flatMap(expand);
  }
  visit(tree);
}

export function headingSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
}

export function wikiTarget(value: string): { id: string; fragment: string; label?: string } {
  const [target = '', ...labels] = value.split('|');
  const index = target.indexOf('#');
  return { id: (index < 0 ? target : target.slice(0, index)).trim(), fragment: index < 0 ? '' : target.slice(index + 1).trim(), ...(labels.length ? { label: labels.join('|') } : {}) };
}
