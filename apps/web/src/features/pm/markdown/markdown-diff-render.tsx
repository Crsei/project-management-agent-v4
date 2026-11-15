import React, { lazy, Suspense } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components, ExtraProps } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import { MarkdownUrlLink } from './preview-url-components.ts';
import type { SyntaxNode } from '../../../../../../packages/pm-markdown/syntax.ts';
import type { HistoryNode, MarkdownBlock, TextRange } from './markdown-diff-model.ts';

const MermaidDiagram = lazy(() => import('./preview-rich.tsx').then(module => ({ default: module.MermaidDiagram })));

function HistoricalLink({ node: _node, href, children, ...props }: React.ComponentProps<'a'> & ExtraProps) {
  // A wiki/attachment/fragment identifies historical content, not permission to resolve today's data.
  if (!href || href.startsWith('#') || href.startsWith('pm-attachment:')) return <span className="md-diff-reference" title={href}>{children}</span>;
  return <MarkdownUrlLink {...props} href={href}>{children}</MarkdownUrlLink>;
}

function HistoricalImage({ src, alt, title }: React.ComponentProps<'img'> & ExtraProps) {
  // Even an HTTPS image can be a tracking endpoint or a same-origin authenticated read.
  return <span className="md-diff-reference" title={title}>{alt || 'Image'} <code>{typeof src === 'string' ? src : ''}</code></span>;
}

/** Produces semantic marks on AST text, never by splicing Markdown or generated HTML. */
export function historicalRenderTree(block: MarkdownBlock, ranges: readonly TextRange[], side: 'before' | 'after', prefix: string): SyntaxNode {
  const root: SyntaxNode = { type: 'root', children: structuredClone([...(block.node ? [block.node] : []), ...block.context.filter(node => node !== block.node)]) };
  let offset = 0;
  function visit(node: SyntaxNode) {
    if (node.type === 'html') { node.type = 'inlineCode'; return; }
    if (node.type === 'workspaceEmbed') {
      const target = String(node.data?.hProperties?.['data-document-embed'] ?? '');
      node.data = { hName: 'span', hProperties: { className: 'md-diff-reference', title: target } };
      node.children = [{ type: 'text', value: `![[${target}]]` }];
      return;
    }
    if (['code', 'math', 'inlineMath', 'definition'].includes(node.type)) return;
    if (node.type === 'text' || node.type === 'inlineCode') {
      const value = node.value ?? ''; const start = offset; offset += value.length;
      const intersections = ranges.filter(range => range.start < offset && range.end > start);
      if (!intersections.length) return;
      if (node.type === 'inlineCode') {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, className: `md-diff-${side === 'before' ? 'removed' : 'added'}` } }; return;
      }
      const children: SyntaxNode[] = []; let cursor = 0;
      for (const range of intersections) {
        const from = Math.max(0, range.start - start); const to = Math.min(value.length, range.end - start);
        if (from > cursor) children.push({ type: 'text', value: value.slice(cursor, from) });
        children.push({ type: 'historyMark', data: { hName: side === 'before' ? 'del' : 'ins', hProperties: { className: 'md-diff-inline' } }, children: [{ type: 'text', value: value.slice(from, to) }] }); cursor = to;
      }
      if (cursor < value.length) children.push({ type: 'text', value: value.slice(cursor) });
      node.type = 'historyText'; delete node.value; node.children = children; node.data = { hName: 'span' }; return;
    }
    if (node.data?.hProperties?.id) node.data.hProperties.id = `${prefix}-${String(node.data.hProperties.id)}`;
    node.children?.forEach(visit);
  }
  // Context nodes are not part of the block's inline-offset stream.
  if (root.children?.[0] && block.node) visit(root.children[0]);
  return root;
}

export function HistoricalMarkdownBlock({ block, ranges = [], side = 'after', prefix, en }: { block: MarkdownBlock; ranges?: readonly TextRange[]; side?: 'before' | 'after'; prefix: string; en: boolean }) {
  if (!block.node) return block.source.trim() ? <pre className="md-diff-literal"><code>{block.source}</code></pre> : null;
  if (block.node.type === 'definition') return <pre className="md-diff-literal"><code>{block.source}</code></pre>;
  const components: Components = {
    a: HistoricalLink,
    img: props => <HistoricalImage {...props} alt={props.alt || (en ? 'Image reference' : '图片引用')} />,
    input: ({ checked }) => <input type="checkbox" disabled checked={!!checked} aria-label={en ? (checked ? 'Completed historical task' : 'Incomplete historical task') : (checked ? '历史任务：已完成' : '历史任务：未完成')} readOnly />,
    aside: ({ node, children }) => <aside className="md-callout" data-callout-type={String(node?.properties?.['data-callout-type'] ?? 'note')}><div className="md-callout-title">{String(node?.properties?.['data-callout-title'] ?? '')}</div>{children}</aside>,
    pre: ({ node }) => {
      const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
      if (!code || code.type !== 'element') return null;
      const language = /(?:^|\s)language-([^\s]+)/.exec(String(code.properties.className ?? ''))?.[1] ?? '';
      const source = code.children.map(child => child.type === 'text' ? child.value : '').join('').replace(/\n$/, '');
      if (language.toLowerCase() === 'mermaid') return <Suspense fallback={<pre><code>{source}</code></pre>}><MermaidDiagram source={source} /></Suspense>;
      return <div className="markdown-code-block"><div className="md-code-language">{language === 'pm-view' ? (en ? 'Historical pm-view · live data not loaded' : '历史 pm-view · 不加载实时数据') : language || 'text'}</div><pre><code>{source}</code></pre></div>;
    },
  };
  function historicalTreePlugin() {
    return (parsed: SyntaxNode) => {
      const tree = historicalRenderTree(block, ranges, side, prefix);
      if (block.node?.type === 'footnoteDefinition' && tree.children?.[0]) {
        tree.children[0].type = 'blockquote';
        tree.children[0].children?.unshift({ type: 'paragraph', children: [{ type: 'text', value: `[^${(block.node as HistoryNode).label ?? block.node.identifier ?? ''}]` }] });
      }
      parsed.children = tree.children;
    };
  }
  return <ReactMarkdown remarkPlugins={[historicalTreePlugin]} remarkRehypeOptions={{ clobberPrefix: `${prefix}-`, footnoteLabel: en ? 'Footnotes' : '脚注', footnoteBackLabel: en ? 'Back to reference' : '返回引用' }} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: 'error', trust: false, maxExpand: 1000, maxSize: 20 }]]} skipHtml urlTransform={url => url} components={components}>{''}</ReactMarkdown>;
}
