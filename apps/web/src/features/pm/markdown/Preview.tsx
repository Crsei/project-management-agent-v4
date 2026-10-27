import React, { createContext, useContext, useEffect, useId, useMemo, useRef } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { Components, ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { parse as parseYaml } from 'yaml';
import { PMView, type ViewProps } from '@pm-views';
import { validateView } from '@pm-schema/query';
import { headingSlug, maskHiddenComments, wikiTarget } from '@pm-markdown';
import { attachmentVersionId, planDocumentEmbeds, remarkWorkspace, type EmbedPlan } from './preview-syntax';
import { AuthorizedAttachment, HighlightedCode, MermaidDiagram } from './preview-rich';
import { MarkdownUrlImage, MarkdownUrlLink } from './preview-url-components';
import 'katex/dist/katex.min.css';
import './preview.css';
import { remarkPersonalMentions } from '../../../../../../packages/pm-markdown/mentions.ts';

type PreviewProps = { raw: string; body: string; viewProps: ViewProps; disabled: boolean; onToggle: (line: number) => void; onLink: (target: string) => void; hideTitle?: boolean };
type BodyProps = PreviewProps & { plans: EmbedPlan[]; embedded?: boolean; fragment?: string };
type RenderingScope = {
  viewProps: ViewProps;
  disabled: boolean;
  onToggle: PreviewProps['onToggle'];
  onLink: PreviewProps['onLink'];
  plans: EmbedPlan[];
  embedded: boolean;
  offset: number;
  currentId?: string;
  currentTitle?: string;
  scrollTo: (target: string) => boolean;
};
const RenderingContext = createContext<RenderingScope | null>(null);

function useRenderingScope(): RenderingScope {
  const scope = useContext(RenderingContext);
  if (!scope) throw new Error('Markdown renderer requires its document scope.');
  return scope;
}

function MarkdownAnchor({ node: _node, href, children, ...props }: React.ComponentProps<'a'> & ExtraProps) {
  const { currentId, currentTitle, scrollTo, onLink } = useRenderingScope();
  if (href?.startsWith('#entity:')) {
    let target: string;
    try { target = decodeURIComponent(href.slice(8)); } catch { return <span>{children}</span>; }
    const parsed = wikiTarget(target);
    const local = !parsed.id || parsed.id === currentId || parsed.id === currentTitle;
    return <button type="button" className="wiki-link" onClick={() => { if (local && parsed.fragment) scrollTo(parsed.fragment); else onLink(`${parsed.id}${parsed.fragment ? `#${parsed.fragment}` : ''}`); }}>{children}</button>;
  }
  const attachment = href && attachmentVersionId(href);
  if (attachment) return <AuthorizedAttachment versionId={attachment} label={React.Children.toArray(children).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : '').join('')} />;
  if (href?.startsWith('#')) return <a {...props} href={href} onClick={event => { event.preventDefault(); try { scrollTo(decodeURIComponent(href.slice(1))); } catch { /* Invalid fragment is inert. */ } }}>{children}</a>;
  return <MarkdownUrlLink {...props} href={href}>{children}</MarkdownUrlLink>;
}

function MarkdownImage({ src, alt = '', width, height, ...props }: React.ComponentProps<'img'> & ExtraProps) {
  const attachment = typeof src === 'string' && attachmentVersionId(src);
  if (attachment) {
    const imageWidth = typeof width === 'number' && width > 0 && width <= 4096 ? width : undefined;
    const imageHeight = typeof height === 'number' && height > 0 && height <= 4096 ? height : undefined;
    return <AuthorizedAttachment versionId={attachment} label={alt} inline width={imageWidth} height={imageHeight} />;
  }
  return <MarkdownUrlImage {...props} src={src} alt={alt} width={width} height={height} />;
}

function MarkdownListItem({ node, children, ...props }: React.ComponentProps<'li'> & ExtraProps) {
  const { disabled, embedded, offset, onToggle } = useRenderingScope();
  const line = Number(node?.properties?.['data-source-line']);
  const toggleChild = (child: React.ReactNode): React.ReactNode => {
    if (!React.isValidElement(child)) return child;
    const element = child as React.ReactElement<{ type?: string; checked?: boolean; children?: React.ReactNode }>;
    if (element.props.type === 'checkbox') return <input type="checkbox" checked={!!element.props.checked} disabled={disabled || embedded} aria-label={`Toggle checklist line ${offset + line}`} onChange={() => onToggle(offset + line)} />;
    if (element.props.children) return React.cloneElement(element, {}, React.Children.map(element.props.children, toggleChild));
    return child;
  };
  return <li {...props}>{Number.isFinite(line) && line > 0 ? React.Children.map(children, toggleChild) : children}</li>;
}

function MarkdownCallout({ node, children }: React.ComponentProps<'aside'> & ExtraProps) {
  const kind = String(node?.properties?.['data-callout-type'] ?? 'note');
  const title = String(node?.properties?.['data-callout-title'] ?? 'Note');
  const collapse = node?.properties?.['data-callout-collapse'];
  return collapse ? <details className="md-callout" data-callout-type={kind} open={collapse === '+'}><summary>{title}</summary><div>{children}</div></details> : <aside className="md-callout" data-callout-type={kind}><div className="md-callout-title">{title}</div>{children}</aside>;
}

function MarkdownSection({ node, children, ...props }: React.ComponentProps<'section'> & ExtraProps) {
  const { plans, viewProps, onToggle, onLink } = useRenderingScope();
  if (!node?.properties?.['data-document-embed']) return <section {...props}>{children}</section>;
  const plan = plans[Number(node.properties['data-embed-index'])];
  if (!plan?.file || plan.error) return <section className="md-document-embed"><p className="inline-error" role="alert">{plan?.error ?? 'Document embed unavailable.'}</p></section>;
  const file = plan.file;
  return <section className="md-document-embed"><header><button type="button" className="wiki-link" onClick={() => onLink(file.id)}>{file.entity.title}</button><span>{file.id}{viewProps.draftIds?.has(file.id) ? ' · Draft' : ''}</span></header><MarkdownBody raw={file.raw} body={file.entity.body} viewProps={{ ...viewProps, selectedId: file.id }} disabled onToggle={onToggle} onLink={onLink} hideTitle plans={plan.children} embedded fragment={wikiTarget(plan.target).fragment || undefined} /></section>;
}

function MarkdownCodeBlock({ node }: React.ComponentProps<'pre'> & ExtraProps) {
  const { viewProps } = useRenderingScope();
  const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
  if (!code || code.type !== 'element') return null;
  const className = Array.isArray(code.properties.className) ? code.properties.className.join(' ') : String(code.properties.className ?? '');
  const language = /(?:^|\s)language-([^\s]+)/.exec(className)?.[1] ?? '';
  const value = code.children.map(child => child.type === 'text' ? child.value : '').join('').replace(/\n$/, '');
  if (language === 'pm-view') {
    try {
      const config = validateView(parseYaml(value), viewProps.configuration);
      return <section className="pm-embed"><div className="embed-heading"><span className="live-dot" />{config.layout === 'graph' ? (viewProps.en === false ? '图谱预览' : 'GRAPH PREVIEW') : 'LIVE VIEW'}<span>{config.layout} · {config.project || 'all projects'}</span></div><PMView {...viewProps} config={config} graphSource={undefined} graphQuery={undefined} graphRefreshKey={undefined} embedded /></section>;
    } catch (error) { return <div className="inline-error" role="alert">Invalid pm-view: {String(error)}</div>; }
  }
  if (language.toLowerCase() === 'mermaid') return <MermaidDiagram source={value} />;
  return <HighlightedCode source={value} language={language} />;
}

// Stable element types retain diagram/media state while the scoped context carries current
// callbacks, editability and authorized records. No document plaintext is cached globally.
const markdownComponents: Components = { a: MarkdownAnchor, img: MarkdownImage, li: MarkdownListItem, aside: MarkdownCallout, section: MarkdownSection, pre: MarkdownCodeBlock };

function MarkdownBody({ raw, body, viewProps, disabled, onToggle, onLink, hideTitle = false, plans, embedded = false, fragment }: BodyProps) {
  const root = useRef<HTMLDivElement>(null);
  const prefix = `pm-md-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const source = useMemo(() => maskHiddenComments(body), [body]);
  const offset = useMemo(() => raw.endsWith(body) ? raw.slice(0, raw.length - body.length).split('\n').length - 1 : 0, [raw, body]);
  const rootFile = (viewProps.allFiles ?? viewProps.files).find(file => file.id === viewProps.selectedId);
  function scrollTo(target: string): boolean {
    const logical = target.startsWith('^') ? `block-${target.slice(1)}` : `heading-${headingSlug(target)}`;
    const element = Array.from(root.current?.querySelectorAll<HTMLElement>('[id]') ?? []).find(item => item.id === target || item.id === `${prefix}-${logical}`);
    if (!element) return false;
    for (let ancestor = element.parentElement; ancestor && ancestor !== root.current; ancestor = ancestor.parentElement) if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    element.scrollIntoView({ block: 'start' });
    return true;
  }
  useEffect(() => {
    const followHash = () => {
      let target = fragment;
      if (!target && !embedded) { try { target = decodeURIComponent(window.location.hash.slice(1)); } catch { return; } }
      if (target) scrollTo(target);
    };
    followHash();
    if (!embedded) window.addEventListener('hashchange', followHash);
    return () => { if (!embedded) window.removeEventListener('hashchange', followHash); };
  }, [prefix, source, embedded, fragment, viewProps.selectedId]);
  const markdown = useMemo(() => <ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkMath, remarkPersonalMentions, [remarkWorkspace, { source, prefix, hideTitle }]]} remarkRehypeOptions={{ clobberPrefix: `${prefix}-` }} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: 'error', trust: false, maxExpand: 1000, maxSize: 20 }]]} skipHtml urlTransform={url => attachmentVersionId(url) ? url : defaultUrlTransform(url)} components={markdownComponents}>{source}</ReactMarkdown>, [source, prefix, hideTitle]);
  const scope: RenderingScope = { viewProps, disabled, onToggle, onLink, plans, embedded, offset, currentId: rootFile?.id, currentTitle: rootFile?.entity.title, scrollTo };
  return <RenderingContext.Provider value={scope}><div ref={root} className={embedded ? 'md-embedded-body' : undefined}>{markdown}</div></RenderingContext.Provider>;
}

export function Preview(props: PreviewProps) {
  const files = props.viewProps.allFiles ?? props.viewProps.files;
  const plans = useMemo(() => planDocumentEmbeds(props.body, files, props.viewProps.selectedId ?? ''), [props.body, files, props.viewProps.selectedId]);
  return <div className="markdown-preview" data-testid="markdown-preview"><MarkdownBody {...props} plans={plans} /></div>;
}
