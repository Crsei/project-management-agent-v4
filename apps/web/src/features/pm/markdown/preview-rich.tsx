import React, { useEffect, useId, useState } from 'react';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import { bundledLanguages, bundledLanguagesAlias, codeToTokens } from 'shiki';
import type { BundledLanguage, ThemedToken } from 'shiki';
import { usePmService } from '../service/pm-service';
import { mediaKind, mermaidSourceError, registeredAttachmentMediaType } from './preview-syntax';
import type { AttachmentMediaKind } from './preview-syntax';
import { PdfPreview } from './preview-pdf';

let graphQueue: Promise<void> = Promise.resolve();

/** Mermaid runs with a locked strict configuration; its output is sanitized and separately sandboxed. */
async function renderGraph(source: string, id: string): Promise<string> {
  const error = mermaidSourceError(source);
  if (error) throw new Error(error);
  const operation = graphQueue.then(async () => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, maxTextSize: 50_000, maxEdges: 500, htmlLabels: false, flowchart: { htmlLabels: false }, secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'flowchart'] });
    const result = await mermaid.render(id, source);
    const sanitized = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed', 'a', 'image', 'use', 'animate', 'animateMotion', 'animateTransform', 'set'], FORBID_ATTR: ['href', 'xlink:href', 'src', 'onload', 'onclick', 'onerror'], ALLOW_DATA_ATTR: false });
    if (!sanitized.includes('<svg')) throw new Error('Diagram did not produce safe SVG.');
    // No network, scripts, forms, navigation, or parent access, even if an SVG sanitizer regresses.
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;background:transparent;font:14px system-ui}svg{display:block;max-width:100%;height:auto;margin:auto}text{fill:currentColor}</style></head><body>${sanitized}</body></html>`;
  });
  graphQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export function MermaidDiagram({ source }: { source: string }) {
  const id = `pm-mermaid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [result, setResult] = useState<{ source: string; document?: string; error?: string } | null>(null);
  useEffect(() => {
    let current = true;
    void renderGraph(source, id).then(document => { if (current) setResult({ source, document }); }, error => { if (current) setResult({ source, error: error instanceof Error ? error.message : 'Invalid Mermaid graph.' }); });
    return () => { current = false; };
  }, [source, id]);
  const active = result?.source === source ? result : null;
  return <div className="md-mermaid">{active?.error ? <p className="inline-error" role="alert">Mermaid: {active.error}</p> : active?.document ? <iframe title="Mermaid diagram" sandbox="" referrerPolicy="no-referrer" srcDoc={active.document} /> : <p role="status">Rendering Mermaid…</p>}<details><summary>Mermaid source</summary><pre><code>{source}</code></pre></details></div>;
}

export function HighlightedCode({ source, language }: { source: string; language: string }) {
  const [highlight, setHighlight] = useState<{ source: string; language: string; tokens: ThemedToken[][] } | null>(null);
  useEffect(() => {
    if (!language || source.length > 100_000) return;
    let current = true;
    if (!Object.hasOwn(bundledLanguages, language) && !Object.hasOwn(bundledLanguagesAlias, language)) return;
    void codeToTokens(source, { lang: language as BundledLanguage, theme: 'github-light' }).then(result => {
      if (current) setHighlight({ source, language, tokens: result.tokens });
    }).catch(() => { /* Unsupported or malformed grammars remain literal code, never executable. */ });
    return () => { current = false; };
  }, [source, language]);
  const tokens = highlight?.source === source && highlight.language === language ? highlight.tokens : null;
  return <div className="markdown-code-block"><div className="md-code-language">{language || 'text'}</div><pre><code className={language ? `language-${language}` : undefined}>{tokens ? tokens.map((line, index) => <React.Fragment key={index}>{line.map((token, tokenIndex) => <span key={tokenIndex} style={{ color: /^#[\da-f]{3,8}$/i.test(token.color ?? '') ? token.color : undefined }}>{token.content}</span>)}{index < tokens.length - 1 ? '\n' : ''}</React.Fragment>) : source}</code></pre></div>;
}

type AttachmentResult = { scope: string; url: string; name: string } & ({ kind: 'pdf'; bytes: Uint8Array } | { kind: Exclude<AttachmentMediaKind, 'pdf'> });
export function AuthorizedAttachment({ versionId, label, inline = false, width, height }: { versionId: string; label: string; inline?: boolean; width?: number; height?: number }) {
  const { client, actor, actorEpoch, workspace } = usePmService();
  const scope = `${actorEpoch}:${actor?.id ?? ''}:${workspace?.id ?? ''}:${workspace?.version ?? ''}:${versionId}`;
  const [result, setResult] = useState<AttachmentResult | null>(null);
  const [requestedScope, setRequestedScope] = useState<string | null>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);
  useEffect(() => {
    if ((!inline && requestedScope !== scope) || !actor || !workspace) return;
    const abort = new AbortController(); let url: string | undefined;
    void Promise.all([
      client.getEntity(workspace.id, versionId, { signal: abort.signal }),
      client.downloadArtifactVersion(workspace.id, versionId, { signal: abort.signal }),
    ]).then(([version, download]) => {
      if (abort.signal.aborted) return;
      if (download.bytes.byteLength > 8 * 1024 * 1024) throw new Error('Attachment exceeds the 8 MiB preview limit.');
      const mediaType = registeredAttachmentMediaType(version, workspace.id, versionId);
      const kind = mediaKind(mediaType);
      const blob = new Blob([Uint8Array.from(download.bytes)], { type: kind === 'download' ? 'application/octet-stream' : mediaType! });
      url = URL.createObjectURL(blob);
      const name = (typeof version.data.fileName === 'string' ? version.data.fileName : versionId).replace(/[\\/\u0000-\u001f]/g, '_') || versionId;
      setResult(kind === 'pdf' ? { scope, url, kind, name, bytes: download.bytes } : { scope, url, kind, name });
      if (!inline) { const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); }
    }).catch(cause => { if (!abort.signal.aborted) setError({ scope, message: cause instanceof Error && cause.message.startsWith('Attachment exceeds') ? cause.message : 'Attachment unavailable in this authorized workspace.' }); });
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url); };
  }, [client, actor?.id, actorEpoch, workspace?.id, versionId, scope, inline, requestedScope]);
  const active = result?.scope === scope ? result : null;
  const failed = error?.scope === scope ? error.message : null;
  if (!actor || !workspace) return <span className="inline-error">Attachment requires an authorized workspace session.</span>;
  if (failed) return <span className="inline-error" role="alert">{failed}</span>;
  if (!active) return inline || requestedScope === scope ? <span role="status">Loading attachment…</span> : <button type="button" className="wiki-link" onClick={() => setRequestedScope(scope)}>{label || 'Download attachment'}</button>;
  if (!inline) return <a href={active.url} download={active.name}>{label || 'Download attachment'}</a>;
  return <span className="md-attachment">{active.kind === 'image' ? <img src={active.url} alt={label} width={width} height={height} style={{ height: height ?? 'auto' }} loading="lazy" /> : active.kind === 'audio' ? <audio src={active.url} controls preload="none" aria-label={label} /> : active.kind === 'video' ? <video src={active.url} controls preload="none" width={width} height={height} aria-label={label} /> : active.kind === 'pdf' ? <PdfPreview key={active.scope} bytes={active.bytes} label={label} /> : <span>Attachment</span>}<a href={active.url} download={active.name}>{label || 'Download attachment'}</a></span>;
}
