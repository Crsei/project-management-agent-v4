import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { createMarkdown, maskHiddenComments, parseMarkdown } from '../../../../../../packages/pm-markdown/index.ts';
import type { FileRecord } from '../../../../../../packages/pm-schema/index.ts';
import type { Entity as ServiceEntity } from '../../../../../../packages/contracts/src/client.ts';
import { attachmentVersionId, embedLimits, mediaKind, mermaidSourceError, planDocumentEmbeds, registeredAttachmentMediaType, remarkWorkspace, resolveDocumentEmbed, safeExternalUrl } from './preview-syntax.ts';
import { MarkdownUrlImage, MarkdownUrlLink } from './preview-url-components.ts';

function record(id: string, body = '', entity = 'document'): FileRecord {
  const raw = createMarkdown({ id, entity, title: `Title ${id}`, body });
  return { id, path: `docs/${id}.md`, raw, revision: `revision-${id}`, entity: parseMarkdown(raw) };
}
function render(body: string, hideTitle = false, components?: Components): string {
  const source = maskHiddenComments(body);
  return renderToStaticMarkup(React.createElement(ReactMarkdown, { children: source, components, skipHtml: true, remarkPlugins: [[remarkGfm, { singleTilde: false }], remarkMath, [remarkWorkspace, { source, prefix: 'fixture', hideTitle }]], remarkRehypeOptions: { clobberPrefix: 'fixture-' }, rehypePlugins: [[rehypeKatex, { strict: 'error', trust: false, throwOnError: false, maxExpand: 1000, maxSize: 20 }]] }));
}

test('real rendered markup contains safe semantic highlights/styles but never author HTML or CSS execution', () => {
  const html = render('=={orange}orange== ++under++ ^up^ ~down~ ~~strike~~ {color:red}red{/color} {font:mono}mono{/font} {size:large}large{/size} ==**bold**==\n\n<script>alert(1)</script>\n\n<span onclick="alert(1)" style="background:url(https://evil.test)">plain</span>');
  assert.match(html, /<mark class="md-highlight md-highlight-orange">orange<\/mark>/);
  assert.match(html, /<u>under<\/u>/);
  assert.match(html, /<sup>up<\/sup>/);
  assert.match(html, /<sub>down<\/sub>/);
  assert.match(html, /<del>strike<\/del>/);
  assert.match(html, /style="color:#dc2626"/);
  assert.match(html, /class="md-font-mono"/);
  assert.match(html, /class="md-size-large"/);
  assert.match(html, /<mark[^>]*><strong>bold<\/strong><\/mark>/);
  assert.doesNotMatch(html, /<script|onclick=|background:|evil\.test/);
});

test('KaTeX renders inline/block math and malformed or untrusted TeX remains a safe visible error', () => {
  const html = render('Inline $x^2 + 1$.\n\n$$\n\\frac{a}{b}\n$$\n\n$\\frac{$\n\n$\\href{javascript:alert(1)}{click}$');
  assert.match(html, /class="katex"/);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /katex-error/);
  assert.doesNotMatch(html, /href="javascript:|<script|onclick=/);
});

test('GFM footnotes and local anchors coexist with hidden title, source lines, block targets and embeds', () => {
  const html = render('# ==Title==\n\n%%\n- [ ] Hidden [[SECRET]]\n%%\n\n## Section\n\nParagraph ^block\n\n[[#Section|Go]] [[#^block|Block]]\n\n![[DOC-2]]\n\n- [ ] Visible\n\nFootnote[^note].\n\n[^note]: Real footnote.', true);
  assert.doesNotMatch(html, /<h1|SECRET|Hidden/);
  assert.match(html, /id="fixture-heading-title"/);
  assert.match(html, /id="fixture-heading-section"/);
  assert.match(html, /id="fixture-block-block"/);
  assert.match(html, /href="#entity:%23Section%7CGo"/);
  assert.match(html, /data-document-embed="DOC-2"/);
  assert.doesNotMatch(html, /<p><section/);
  assert.match(html, /data-source-line="15"/);
  assert.match(html, /data-footnotes/);
  assert.match(html, /Real footnote/);
});

test('image dimensions are rendered as bounded attributes while escaped non-table dimensions remain literal', () => {
  const html = render('![diagram|640x480](https://example.test/a.png)\n\n![literal\\|640](https://example.test/a.png)\n\n| Image |\n| --- |\n| ![cell\\|320](https://example.test/a.png) |');
  assert.match(html, /alt="diagram" width="640" height="480"/);
  assert.match(html, /alt="literal\|640"/);
  assert.match(html, /alt="cell" width="320"/);
});

test('authorization scope and real document identity are required for an embed without hidden record leakage', () => {
  const visible = record('DOC-1'); const task = record('TASK-1', '', 'work_item');
  const state = { ids: ['ROOT'], count: 0, size: 0 };
  const allowed = resolveDocumentEmbed('DOC-1', [visible, task], state);
  assert.ok('file' in allowed && allowed.file === visible);
  const missing = resolveDocumentEmbed('SECRET-DOC', [visible, task], state);
  assert.deepEqual(missing, resolveDocumentEmbed('TASK-1', [visible, task], state));
  assert.deepEqual(missing, resolveDocumentEmbed('DOC-1', [{ ...visible, stale: true }], state));
  assert.ok('error' in missing && !missing.error.includes('SECRET-DOC'));
  assert.deepEqual(planDocumentEmbeds('%% ![[SECRET-DOC]] %%\n\n`![[DOC-1]]`\n\n$![[DOC-1]]$\n\n![[DOC-1]]', [visible], 'ROOT').map(plan => plan.file?.id), ['DOC-1']);
});

test('recursive document embeds share finite depth, count and total size budgets across siblings', () => {
  const a = record('DOC-10', '![[DOC-11]]'); const b = record('DOC-11', '![[DOC-10]]');
  const cycle = planDocumentEmbeds('![[DOC-10]]', [a, b], 'DOC-0');
  assert.match(cycle[0]!.children[0]!.children[0]!.error!, /cycle/);
  const chain = ['DOC-10', 'DOC-11', 'DOC-12', 'DOC-13', 'DOC-14'].map((id, index, ids) => record(id, ids[index + 1] ? `![[${ids[index + 1]}]]` : 'End'));
  const limited = planDocumentEmbeds('![[DOC-10]]', chain, 'DOC-0');
  assert.match(limited[0]!.children[0]!.children[0]!.children[0]!.error!, /depth/);
  const one = record('DOC-20');
  const repeated = planDocumentEmbeds(Array.from({ length: embedLimits.count + 2 }, () => '![[DOC-20]]').join('\n\n'), [one], 'DOC-0');
  assert.equal(repeated.filter(plan => plan.file).length, embedLimits.count);
  assert.ok(repeated.slice(embedLimits.count).every(plan => /count/.test(plan.error ?? '')));
  const large = record('DOC-30', 'x'.repeat(embedLimits.documentSize));
  assert.match(planDocumentEmbeds('![[DOC-30]]', [large], 'DOC-0')[0]!.error!, /size/);
  const medium = record('DOC-40', 'x'.repeat(60_000));
  const total = planDocumentEmbeds(Array.from({ length: 6 }, () => '![[DOC-40]]').join('\n\n'), [medium], 'DOC-0');
  assert.equal(total.filter(plan => plan.file).length, 4);
  assert.ok(total.slice(4).every(plan => /size/.test(plan.error ?? '')));
});

test('attachments are immutable references, external credentials and executable media schemes are not trusted', () => {
  const id = '12345678-1234-4234-8234-123456789abc';
  assert.equal(attachmentVersionId(`pm-attachment:${encodeURIComponent(id)}`), id);
  for (const url of ['pm-attachment:../private', 'pm-attachment:%ZZ', `https://example.test/${id}`, 'pm-attachment:javascript:alert(1)']) assert.equal(attachmentVersionId(url), undefined);
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'blob:https://example.test/untrusted', 'https://user:token@example.test/a', '//example.test/a', 'https://example.test/a\n']) assert.equal(safeExternalUrl(url), undefined);
  assert.equal(safeExternalUrl('https://example.test/a.png'), 'https://example.test/a.png');
  assert.equal(mediaKind('image/png; charset=binary'), 'image');
  assert.equal(mediaKind('audio/mpeg'), 'audio');
  assert.equal(mediaKind('video/mp4'), 'video');
  assert.equal(mediaKind('application/pdf'), 'pdf');
  for (const mime of ['image/svg+xml', 'text/html', 'application/javascript', null]) assert.equal(mediaKind(mime), 'download');
});

test('Mermaid source permits real diagrams but rejects config overrides, click handlers and excess size', () => {
  assert.equal(mermaidSourceError('flowchart TD\n A[Start] --> B[Finish]'), undefined);
  for (const source of ['%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\nA-->B', 'flowchart TD\nclick A "javascript:alert(1)"', '---\nconfig:\n securityLevel: loose\n---\nflowchart TD\nA-->B', 'x'.repeat(50_001)]) assert.ok(mermaidSourceError(source));
});

test('callouts retain real type/title/collapse metadata and do not activate escaped markers or fenced examples', () => {
  const html = render('> [!warning]- Review carefully\n> Body remains visible.\n\n> \\[!tip] Literal\n\n```md\n> [!risk] Code example\n```');
  assert.match(html, /data-callout-type="warning"/);
  assert.match(html, /data-callout-title="Review carefully"/);
  assert.match(html, /data-callout-collapse="-"/);
  assert.match(html, /Body remains visible/);
  assert.doesNotMatch(html, /data-callout-type="tip"|data-callout-type="risk"/);
});

test('inline attachment MIME comes from the matching authorized artifact version, not download policy or filename', () => {
  const version: ServiceEntity = { id: '12345678-1234-4234-8234-123456789abc', workspaceId: 'workspace-1', projectId: 'PRJ-1', kind: 'artifact_version', version: 1, data: { mediaType: 'image/webp', fileName: 'unrelated.html' }, createdAt: null, updatedAt: null, createdBy: 'actor-1' };
  assert.equal(mediaKind('application/octet-stream'), 'download');
  assert.equal(mediaKind(registeredAttachmentMediaType(version, version.workspaceId, version.id)), 'image');
  for (const mediaType of ['image/svg+xml', 'text/html', 'application/javascript']) assert.equal(mediaKind(registeredAttachmentMediaType({ ...version, data: { mediaType, fileName: 'pretend.webp' } }, version.workspaceId, version.id)), 'download');
  assert.equal(mediaKind(registeredAttachmentMediaType({ ...version, data: { fileName: 'pretend.webp' } }, version.workspaceId, version.id)), 'download');
  assert.throws(() => registeredAttachmentMediaType({ ...version, kind: 'upload' }, version.workspaceId, version.id), /unavailable/);
  assert.throws(() => registeredAttachmentMediaType(version, 'another-workspace', version.id), /unavailable/);
  assert.throws(() => registeredAttachmentMediaType(version, version.workspaceId, 'another-version'), /unavailable/);
});

test('actual URL consumers retain local raster images and relative links without trusting unsafe URLs', () => {
  const html = render('![local|480](/images/fixture-cover.webp)\n\n![relative](../assets/diagram.png)\n\n[Guide](./guide.md#part)\n\n[Workspace](/pm/workspaces/demo)\n\n[Unsafe](//evil.example/guide)\n\n![Unsafe](//evil.example/image.png)\n\n[Credentials](https://name:secret@evil.example/)', false, { a: MarkdownUrlLink, img: MarkdownUrlImage });
  assert.match(html, /<img[^>]*src="\/images\/fixture-cover\.webp"[^>]*alt="local"[^>]*width="480"/);
  assert.match(html, /<img[^>]*src="\.\.\/assets\/diagram\.png"/);
  assert.match(html, /<a[^>]*href="\.\/guide\.md#part"/);
  assert.match(html, /<a[^>]*href="\/pm\/workspaces\/demo"/);
  assert.doesNotMatch(html, /(?:src|href)="(?:\/\/evil\.example|https:\/\/name:secret@)/);
  for (const url of ['/images/cover.webp', './assets/diagram.png', '../guide.md#section', 'guide.md?mode=read']) assert.equal(safeExternalUrl(url), url);
  for (const url of ['//evil.example/a', '/\\evil.example/a', '\\\\evil.example/a', 'file:///private/a.png', 'javascript:alert(1)', '/images/a\u0085.png']) assert.equal(safeExternalUrl(url), undefined);
});
