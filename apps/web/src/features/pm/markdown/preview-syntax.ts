import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { enhanceMarkdownTree, headingSlug, maskHiddenComments, wikiTarget, type SyntaxNode } from '../../../../../../packages/pm-markdown/syntax.ts';
import type { FileRecord } from '../../../../../../packages/pm-schema/index.ts';
import type { Entity as ServiceEntity } from '../../../../../../packages/contracts/src/client.ts';

export const embedLimits = { depth: 3, count: 16, documentSize: 64 * 1024, totalSize: 256 * 1024 };
export type EmbedState = { ids: readonly string[]; count: number; size: number };
export type EmbedResolution = { file: FileRecord; state: EmbedState } | { error: string };
export type EmbedPlan = { target: string; file?: FileRecord; error?: string; children: EmbedPlan[] };

/** Preflight the entire expansion once; sibling embeds share the same total budget. */
export function planDocumentEmbeds(body: string, files: readonly FileRecord[], rootId: string): EmbedPlan[] {
  const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath);
  const budget = { count: 0, size: 0 };
  function plan(source: string, ids: string[]): EmbedPlan[] {
    const masked = maskHiddenComments(source);
    const tree = parser.parse(masked) as SyntaxNode;
    remarkWorkspace({ source: masked, prefix: 'embed-plan' })(tree);
    const result: EmbedPlan[] = [];
    function visit(node: SyntaxNode) {
      if (node.type === 'workspaceEmbed') {
        const target = String(node.data?.hProperties?.['data-document-embed'] ?? '');
        const resolved = resolveDocumentEmbed(target, files, { ids, ...budget });
        if ('error' in resolved) result.push({ target, error: resolved.error, children: [] });
        else {
          budget.count = resolved.state.count; budget.size = resolved.state.size;
          result.push({ target, file: resolved.file, children: plan(resolved.file.entity.body, [...ids, resolved.file.id]) });
        }
        return;
      }
      node.children?.forEach(visit);
    }
    visit(tree);
    return result;
  }
  return plan(body, rootId ? [rootId] : []);
}

/** The caller passes only the workspace snapshot already authorized by the real service. */
export function resolveDocumentEmbed(target: string, files: readonly FileRecord[], state: EmbedState): EmbedResolution {
  const { id } = wikiTarget(target);
  const file = files.find(candidate => candidate.id === id && candidate.entity.entity === 'document');
  // Do not distinguish missing, unauthorized, and non-document targets, or expose their titles.
  if (!file || file.stale) return { error: 'Document unavailable in this authorized workspace scope.' };
  if (state.ids.includes(file.id)) return { error: 'Document embed cycle stopped.' };
  if (state.ids.length >= embedLimits.depth + 1) return { error: 'Document embed depth limit reached.' };
  if (state.count >= embedLimits.count) return { error: 'Document embed count limit reached.' };
  if (file.raw.length > embedLimits.documentSize || state.size + file.raw.length > embedLimits.totalSize) return { error: 'Document embed size limit reached.' };
  return { file, state: { ids: [...state.ids, file.id], count: state.count + 1, size: state.size + file.raw.length } };
}

export function attachmentVersionId(url: string): string | undefined {
  if (!url.startsWith('pm-attachment:')) return undefined;
  try {
    const value = decodeURIComponent(url.slice('pm-attachment:'.length));
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
  } catch { return undefined; }
}

export function safeExternalUrl(value: string): string | undefined {
  if (!value || /[\u0000-\u0020\u007f-\u009f\\]/.test(value) || value.startsWith('//')) return undefined;
  try {
    // The reserved base is only for URL parsing; return the author's relative path unchanged.
    const base = 'https://markdown.invalid';
    const url = new URL(value, base);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) return undefined;
    if (!/^[a-z][a-z\d+.-]*:/i.test(value) && url.origin !== base) return undefined;
    return value;
  } catch { return undefined; }
}
export type AttachmentMediaKind = 'image' | 'audio' | 'video' | 'pdf' | 'download';
export function mediaKind(mediaType: string | null): AttachmentMediaKind {
  const mime = (mediaType ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'].includes(mime)) return 'image';
  if (['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/flac'].includes(mime)) return 'audio';
  if (['video/mp4', 'video/webm', 'video/ogg'].includes(mime)) return 'video';
  return mime === 'application/pdf' ? 'pdf' : 'download';
}

/** Download responses deliberately use octet-stream. Only an authorized immutable version
 * record, never a Markdown filename or URL, may select an inline preview media type. */
export function registeredAttachmentMediaType(version: ServiceEntity, workspaceId: string, versionId: string): string | null {
  if (version.kind !== 'artifact_version' || version.workspaceId !== workspaceId || version.id !== versionId) throw new Error('Attachment unavailable in this authorized workspace.');
  return typeof version.data.mediaType === 'string' ? version.data.mediaType.trim().toLowerCase() : null;
}
export function mermaidSourceError(source: string): string | undefined {
  if (source.length > 50_000) return 'Mermaid source exceeds the 50,000 character limit.';
  if (/%%\s*\{|^\s*---|^\s*click\s/im.test(source)) return 'Mermaid configuration directives and clickable actions are disabled.';
  return undefined;
}
function text(node: SyntaxNode): string { return node.value ?? node.children?.map(text).join('') ?? ''; }
function properties(node: SyntaxNode, values: Record<string, unknown>) { node.data = { ...node.data, hProperties: { ...node.data?.hProperties, ...values } }; }

export function remarkWorkspace({ source, prefix, hideTitle = false }: { source: string; prefix: string; hideTitle?: boolean }) {
  return (tree: SyntaxNode) => {
    enhanceMarkdownTree(tree, source);
    const headings = new Map<string, number>();
    let titleHidden = false;
    let embedIndex = 0;
    function indexEmbeds(node: SyntaxNode) {
      if (node.type === 'workspaceEmbed') { properties(node, { 'data-embed-index': embedIndex++ }); return; }
      node.children?.forEach(indexEmbeds);
    }
    indexEmbeds(tree);
    function visit(node: SyntaxNode) {
      if (node.type === 'workspaceEmbed') return;
      if (node.type === 'listItem' && typeof node.checked === 'boolean') properties(node, { 'data-source-line': node.position?.start.line });
      if (node.type === 'heading') {
        const slug = headingSlug(text(node)); const count = headings.get(slug) ?? 0; headings.set(slug, count + 1);
        properties(node, { id: `${prefix}-heading-${slug}${count ? `-${count}` : ''}` });
        if (hideTitle && node.depth === 1 && !titleHidden && tree.children?.includes(node)) {
          titleHidden = true; node.type = 'workspaceAnchor'; node.data = { ...node.data, hName: 'span' }; properties(node, { className: 'md-hidden-heading', 'aria-hidden': true }); node.children = [];
        }
      }
      if (node.type === 'blockquote') {
        const paragraph = node.children?.[0]; const first = paragraph?.children?.[0];
        const start = paragraph?.position?.start.offset;
        const marker = first?.type === 'text' && start !== undefined && source.slice(start, start + 2) === '[!' ? /^\[!([A-Za-z][\w-]*)\]([+-])?(?:[ \t]+([^\n]*))?(?:\n|$)/.exec(first.value ?? '') : null;
        if (marker && first && paragraph) {
          const kind = marker[1]!.toLowerCase(); const title = marker[3]?.trim() || kind[0]!.toUpperCase() + kind.slice(1);
          first.value = first.value!.slice(marker[0].length);
          if (!first.value) paragraph.children!.shift();
          if (!paragraph.children?.length) node.children!.shift();
          node.type = 'workspaceCallout'; node.data = { hName: 'aside', hProperties: { className: 'md-callout', 'data-callout-type': kind, 'data-callout-title': title, ...(marker[2] ? { 'data-callout-collapse': marker[2] } : {}) } };
        }
      }
      const block = node.data?.hProperties?.['data-block-id'];
      if (typeof block === 'string') properties(node, { id: `${prefix}-block-${block}` });
      if (!node.children || ['code', 'inlineCode', 'html', 'link', 'math', 'inlineMath'].includes(node.type)) return;
      node.children.forEach(visit);
      // Lift flow embeds through inline formatting and paragraphs, preserving surrounding
      // Markdown without creating invalid sections inside strong/mark/paragraph elements.
      node.children = node.children.flatMap(child => {
        if (!['paragraph', 'heading', 'emphasis', 'strong', 'delete', 'workspaceStyle'].includes(child.type) || !child.children?.some(item => item.type === 'workspaceEmbed')) return [child];
        const split: SyntaxNode[] = []; let inline: SyntaxNode[] = [];
        for (const item of child.children) {
          if (item.type === 'workspaceEmbed') { if (inline.length) split.push({ ...child, children: inline }); split.push(item); inline = []; }
          else inline.push(item);
        }
        if (inline.length) split.push({ ...child, children: inline });
        return split;
      });
    }
    visit(tree);
  };
}
