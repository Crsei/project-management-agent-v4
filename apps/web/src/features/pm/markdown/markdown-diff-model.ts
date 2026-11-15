import { diffArrays } from 'diff';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { maskHiddenComments, type SyntaxNode } from '../../../../../../packages/pm-markdown/syntax.ts';
import { remarkWorkspace } from './preview-syntax.ts';

/** Bounds apply before parsing and before every potentially quadratic alignment. */
export const markdownDiffLimits = { characters: 160_000, blocks: 500, nodes: 12_000, depth: 64, blockCharacters: 24_000, inlineTokens: 8_000, editLength: 1_024, diagrams: 16, formulas: 128, mathCharacters: 8_000, expandedNodes: 24_000, referenceCharacters: 256_000 } as const;
export type HistoryNode = SyntaxNode & { identifier?: string; label?: string; lang?: string | null; meta?: string | null };
export type MarkdownBlock = { node: HistoryNode | null; source: string; start: number; end: number; text: string; context: HistoryNode[]; key: string };
export type TextRange = { start: number; end: number };
export type MarkdownChange = { kind: 'equal' | 'added' | 'removed' | 'changed'; before?: MarkdownBlock; after?: MarkdownBlock; beforeRanges: TextRange[]; afterRanges: TextRange[]; syntaxOnly: boolean };
export type MarkdownDiffModel = { kind: 'rendered'; changes: MarkdownChange[]; count: number } | { kind: 'fallback'; reason: 'size' | 'structure' | 'complexity' | 'unsupported' };
const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath);
const supported: Record<string, true> = Object.fromEntries(['root', 'paragraph', 'heading', 'text', 'emphasis', 'strong', 'delete', 'link', 'linkReference', 'image', 'imageReference', 'definition', 'footnoteReference', 'footnoteDefinition', 'blockquote', 'list', 'listItem', 'table', 'tableRow', 'tableCell', 'code', 'inlineCode', 'math', 'inlineMath', 'html', 'break', 'thematicBreak', 'workspaceStyle', 'workspaceCallout', 'workspaceEmbed', 'workspaceAnchor'].map(type => [type, true]));
class DiffLimit extends Error {
  readonly reason: Extract<MarkdownDiffModel, { kind: 'fallback' }>['reason'];
  constructor(reason: Extract<MarkdownDiffModel, { kind: 'fallback' }>['reason']) { super(reason); this.reason = reason; }
}

/** Atomic nodes are not spliced: a formula, code fence or embed keeps its semantics. */
export function markdownVisibleText(node: SyntaxNode | null): string {
  if (!node) return '';
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? '';
  if (['code', 'math', 'inlineMath', 'html', 'workspaceEmbed', 'definition'].includes(node.type)) return '';
  return node.children?.map(markdownVisibleText).join('') ?? '';
}

function checkTree(root: SyntaxNode) {
  const queue = [{ node: root, depth: 0 }]; let nodes = 0; let diagrams = 0;
  while (queue.length) {
    const { node, depth } = queue.pop()!;
    if (++nodes > markdownDiffLimits.nodes || depth > markdownDiffLimits.depth) throw new DiffLimit('structure');
    if (!Object.hasOwn(supported, node.type)) throw new DiffLimit('unsupported');
    if (['math', 'inlineMath'].includes(node.type) && (node.value?.length ?? 0) > markdownDiffLimits.mathCharacters) throw new DiffLimit('structure');
    if (node.type === 'code' && (node as HistoryNode).lang?.toLowerCase() === 'mermaid' && ++diagrams > markdownDiffLimits.diagrams) throw new DiffLimit('structure');
    for (const child of node.children ?? []) queue.push({ node: child, depth: depth + 1 });
  }
}

function blocks(source: string): MarkdownBlock[] {
  const masked = maskHiddenComments(source);
  const tree = parser.parse(masked) as HistoryNode;
  checkTree(tree);
  const originals = (tree.children ?? []).map(node => ({ node, start: node.position?.start.offset, end: node.position?.end.offset }));
  // Context is document-wide: reference links and footnotes must not resolve against a block fragment.
  const definitions = new Map<string, HistoryNode>();
  for (const node of (tree.children ?? []) as HistoryNode[]) {
    if (node.type !== 'definition' && node.type !== 'footnoteDefinition') continue;
    const key = `${node.type}:${node.identifier ?? ''}`;
    if (!definitions.has(key)) definitions.set(key, node);
  }
  remarkWorkspace({ source: masked, prefix: 'history' })(tree);
  checkTree(tree);
  const result: MarkdownBlock[] = []; let cursor = 0;
  let renderedNodes = 0; let formulas = 0; let diagrams = 0; let referenceCharacters = 0;
  function append(node: HistoryNode | null, start: number, end: number) {
    const raw = source.slice(start, end);
    if (raw.length > markdownDiffLimits.blockCharacters) throw new DiffLimit('structure');
    const context: HistoryNode[] = []; const seen = new Set<HistoryNode>();
    function visit(item: HistoryNode) {
      if (++renderedNodes > markdownDiffLimits.expandedNodes) throw new DiffLimit('structure');
      if (['math', 'inlineMath'].includes(item.type) && ++formulas > markdownDiffLimits.formulas) throw new DiffLimit('structure');
      if (item.type === 'code' && item.lang?.toLowerCase() === 'mermaid' && ++diagrams > markdownDiffLimits.diagrams) throw new DiffLimit('structure');
      if (['linkReference', 'imageReference', 'footnoteReference'].includes(item.type)) {
        const definition = definitions.get(`${item.type === 'footnoteReference' ? 'footnoteDefinition' : 'definition'}:${item.identifier ?? ''}`);
        if (definition && definition !== node && !seen.has(definition)) { seen.add(definition); context.push(definition); visit(definition); }
      }
      item.children?.forEach(visit);
    }
    if (node) visit(node);
    const referenceContext = context.map(item => source.slice(item.position?.start.offset ?? 0, item.position?.end.offset ?? 0));
    referenceCharacters += referenceContext.reduce((length, value) => length + value.length, 0);
    if (referenceCharacters > markdownDiffLimits.referenceCharacters) throw new DiffLimit('structure');
    result.push({ node, source: raw, start, end, text: markdownVisibleText(node), context, key: JSON.stringify([raw, referenceContext]) });
  }
  // Use original top-level spans, not transformed children (an embed may split a paragraph).
  for (const original of originals) {
    const { start, end } = original;
    if (start === undefined || end === undefined || start < cursor) throw new DiffLimit('unsupported');
    if (start > cursor) append(null, cursor, start);
    append(original.node, start, end); cursor = end;
  }
  if (cursor < source.length) append(null, cursor, source.length);
  if (result.length > markdownDiffLimits.blocks) throw new DiffLimit('structure');
  return result;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function tokens(value: string): string[] {
  const result: string[] = [];
  for (const { segment } of segmenter.segment(value)) {
    result.push(segment);
    if (result.length > markdownDiffLimits.inlineTokens) throw new DiffLimit('complexity');
  }
  return result;
}

export function markdownTextRanges(before: string, after: string): { beforeRanges: TextRange[]; afterRanges: TextRange[] } {
  if (before === after) return { beforeRanges: [], afterRanges: [] };
  const parts = diffArrays(tokens(before), tokens(after), { maxEditLength: markdownDiffLimits.editLength, timeout: 25 });
  if (!parts) throw new DiffLimit('complexity');
  const beforeRanges: TextRange[] = []; const afterRanges: TextRange[] = []; let oldOffset = 0; let newOffset = 0;
  for (const part of parts) {
    const length = part.value.reduce((total, token) => total + token.length, 0);
    if (part.removed) { beforeRanges.push({ start: oldOffset, end: oldOffset + length }); oldOffset += length; }
    else if (part.added) { afterRanges.push({ start: newOffset, end: newOffset + length }); newOffset += length; }
    else { oldOffset += length; newOffset += length; }
  }
  return { beforeRanges, afterRanges };
}

/** Exact source coverage includes blank lines, comments, definitions and final-newline changes. */
export function buildMarkdownDiff(before: string, after: string): MarkdownDiffModel {
  if (before.length + after.length > markdownDiffLimits.characters) return { kind: 'fallback', reason: 'size' };
  try {
    const oldBlocks = blocks(before); const newBlocks = blocks(after);
    const alignment = diffArrays(oldBlocks, newBlocks, { comparator: (a, b) => a.key === b.key, maxEditLength: markdownDiffLimits.editLength, timeout: 75 });
    if (!alignment) throw new DiffLimit('complexity');
    const changes: MarkdownChange[] = []; const started = Date.now();
    function add(oldBlock: MarkdownBlock | undefined, newBlock: MarkdownBlock | undefined) {
      if (Date.now() - started > 150) throw new DiffLimit('complexity');
      const kind = !oldBlock ? 'added' : !newBlock ? 'removed' : oldBlock.key === newBlock.key ? 'equal' : 'changed';
      const ranges = kind === 'changed' ? markdownTextRanges(oldBlock!.text, newBlock!.text) : { beforeRanges: [], afterRanges: [] };
      changes.push({ kind, ...(oldBlock ? { before: oldBlock } : {}), ...(newBlock ? { after: newBlock } : {}), ...ranges, syntaxOnly: kind !== 'equal' && (oldBlock?.text ?? '') === (newBlock?.text ?? '') });
    }
    let oldCursor = 0; let newCursor = 0;
    for (let index = 0; index < alignment.length; index++) {
      const part = alignment[index]!;
      if (!part.added && !part.removed) {
        for (let equal = 0; equal < part.value.length; equal++) add(oldBlocks[oldCursor++], newBlocks[newCursor++]);
        continue;
      }
      const removed = part.removed ? part.value : [];
      const next = alignment[index + 1];
      const added = part.added ? part.value : next?.added ? next.value : [];
      if (part.removed && next?.added) index++;
      oldCursor += removed.length; newCursor += added.length;
      // Pair only compatible node types; structural replacements remain explicit deletion/addition.
      let oldIndex = 0; let newIndex = 0;
      while (oldIndex < removed.length || newIndex < added.length) {
        const oldBlock = removed[oldIndex]; const newBlock = added[newIndex];
        if (oldBlock && newBlock && oldBlock.node?.type === newBlock.node?.type) { add(oldBlock, newBlock); oldIndex++; newIndex++; }
        else if (oldBlock) { add(oldBlock, undefined); oldIndex++; }
        else { add(undefined, newBlock); newIndex++; }
      }
    }
    return { kind: 'rendered', changes, count: changes.filter(change => change.kind !== 'equal').length };
  } catch (error) {
    return { kind: 'fallback', reason: error instanceof DiffLimit ? error.reason : 'unsupported' };
  }
}
