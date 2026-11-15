import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildMarkdownDiff, markdownDiffLimits, markdownTextRanges, type MarkdownBlock, type MarkdownChange, type MarkdownDiffModel } from './markdown-diff-model.ts';
// Node's native TS runner strips types but not JSX; execute the real renderer
// through the same JSX runtime as Vite without bundling a second implementation.
const jsxLoader = registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('/markdown-diff-render.tsx')) return nextLoad(url, context);
    return { format: 'module', shortCircuit: true, source: transformSync(readFileSync(new URL(url), 'utf8'), { loader: 'tsx', jsx: 'automatic', format: 'esm' }).code };
  },
});
after(() => jsxLoader.deregister());
// Static import would execute before the JSX loader has been registered.
const { HistoricalMarkdownBlock, historicalRenderTree } = await import('./markdown-diff-render.tsx');

function compare(before: string, after: string): Extract<MarkdownDiffModel, { kind: 'rendered' }> {
  const model = buildMarkdownDiff(before, after);
  if (model.kind !== 'rendered') throw new Error(`Unexpected fallback: ${model.reason}`);
  // Every source character, including inter-block trivia, belongs to exactly one endpoint block.
  assert.equal(model.changes.map(change => change.before?.source ?? '').join(''), before);
  assert.equal(model.changes.map(change => change.after?.source ?? '').join(''), after);
  for (const side of ['before', 'after'] as const) {
    let cursor = 0;
    for (const change of model.changes) {
      const block: MarkdownBlock | undefined = change[side]; if (!block) continue;
      assert.equal(block.start, cursor);
      assert.equal((side === 'before' ? before : after).slice(block.start, block.end), block.source);
      cursor = block.end;
    }
  }
  return model;
}
function render(block: MarkdownBlock, ranges: MarkdownChange['afterRanges'] = [], side: 'before' | 'after' = 'after') {
  return renderToStaticMarkup(React.createElement(HistoricalMarkdownBlock, { block, ranges, side, prefix: 'fixture', en: true }));
}
function endpoint(source: string) {
  return compare('', source).changes.flatMap(change => change.after ? [change.after] : []);
}

test('Chinese inline changes keep rich formatting and mark only changed graphemes', () => {
  const model = compare('# 计划\n\n请**修改旧任务**，保留链接[说明](https://example.test)。', '# 计划\n\n请**修改新任务**，保留链接[说明](https://example.test)。');
  const change = model.changes.find(item => item.kind === 'changed')!;
  assert.equal(model.count, 1);
  assert.match(render(change.before!, change.beforeRanges, 'before'), /<strong>.*<del class="md-diff-inline">旧<\/del>.*<\/strong>/);
  assert.match(render(change.after!, change.afterRanges), /<strong>.*<ins class="md-diff-inline">新<\/ins>.*<\/strong>/);
  assert.match(render(change.after!, change.afterRanges), /href="https:\/\/example.test"/);
  assert.deepEqual(markdownTextRanges('A👩‍💻中', 'A👨‍💻中'), { beforeRanges: [{ start: 1, end: 6 }], afterRanges: [{ start: 1, end: 6 }] });
});

test('format-only, URL-only and invisible source edits never compare equal', () => {
  for (const [before, after] of [['plain', '**plain**'], ['**bold**', '__bold__'], ['[same](https://a.test)', '[same](https://b.test)'], ['A\n', 'A\n\n'], ['A\n\n%% first %%', 'A\n\n%% second %%'], ['A &amp; B', 'A & B'], ['A  \nB', 'A\nB']]) {
    const model = compare(before!, after!);
    assert.ok(model.count > 0, `${before} -> ${after}`);
    assert.ok(model.changes.some(change => change.kind !== 'equal' && change.before?.source !== change.after?.source));
  }
  const formatting = compare('**bold**', '__bold__').changes.find(change => change.kind === 'changed')!;
  assert.equal(formatting.syntaxOnly, true);
  assert.match(render(formatting.after!), /<strong>bold<\/strong>/);
});

test('structural replacements, repeated blocks and CRLF retain both exact endpoints', () => {
  for (const [before, after] of [
    ['# Title\n\nSame\n\nSame\n\n- old', '## Title\n\nSame\n\n> New\n\nSame\n\n1. new'],
    ['\r\n# A\r\n\r\nParagraph\r\n', '# A\n\nParagraph'],
    ['', 'New\n'], ['Removed\n', ''], [' \n\t', '\n'], ['A\n\nB', 'B\n\nA'],
  ]) assert.ok(compare(before!, after!).count > 0);
  assert.equal(compare('## Same\n\n- [x] Ready', '## Same\n\n- [x] Ready').count, 0);
});

test('GFM tables and task lists remain semantic and tasks are always disabled', () => {
  const source = '- [x] **Ready**\n- [ ] Waiting\n\n| 名称 | 状态 |\n| :--- | ---: |\n| 任务 | ~~旧~~ **新** |';
  const html = endpoint(source).map(block => render(block)).join('');
  assert.match(html, /<input[^>]*disabled=""[^>]*checked=""/);
  assert.match(html, /Incomplete historical task/);
  assert.match(html, /<table>/);
  assert.match(html, /<th[^>]*>名称<\/th>/);
  assert.match(html, /<del>旧<\/del>/);
  assert.match(html, /<strong>新<\/strong>/);
  assert.doesNotMatch(html, /onchange=|onclick=/i);
});

test('reference definitions resolve within each complete snapshot and target edits mark their consumers', () => {
  const before = '[Guide][g]\n\nUnrelated.\n\n[g]: https://old.test "Old"';
  const after = '[Guide][g]\n\nUnrelated.\n\n[g]: https://new.test "New"';
  const model = compare(before, after);
  const reference = model.changes.find(change => change.before?.source === '[Guide][g]')!;
  assert.equal(reference.kind, 'changed');
  assert.match(render(reference.before!), /href="https:\/\/old.test"/);
  assert.match(render(reference.after!), /href="https:\/\/new.test"/);
  assert.equal(model.changes.find(change => change.after?.source === 'Unrelated.')?.kind, 'equal');
  const footnote = endpoint('Text[^n].\n\n[^n]: **Footnote** with [link][g].\n\n[g]: https://example.test').find(block => block.source.startsWith('Text'))!;
  assert.match(render(footnote), /<strong>Footnote<\/strong>/);
  assert.match(render(footnote), /href="https:\/\/example.test"/);
});

test('raw HTML, dangerous URLs and all image/attachment references remain inert without a PM provider', () => {
  const source = '<script>alert(1)</script>\n\n[bad](javascript:alert%281%29) [credentials](https://name:secret@evil.test/) [attachment](pm-attachment:12345678-1234-4234-8234-123456789abc)\n\n![track](https://evil.test/pixel.png) ![private](/api/v1/private)\n\n<img src=x onerror=alert(1)>';
  const html = endpoint(source).map(block => render(block)).join('');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /track/);
  assert.match(html, /https:\/\/evil.test\/pixel.png/);
  assert.doesNotMatch(html, /<script|<img\b|<iframe\b|href="(?:javascript:|pm-attachment:|https:\/\/name:)|<[^>]+\s(?:src|onerror)=/i);
});

test('custom styles and callouts render while embeds and pm-view stay historical literals', () => {
  const source = '==**Highlight**== ++under++ {color:red}red{/color}\n\n> [!warning]- Review\n> Keep visible.\n\n![[DOC-1]] and ![[DOC-2|Other]]\n\n```pm-view\nlayout: table\nquery: all\n```';
  const html = endpoint(source).map(block => render(block)).join('');
  assert.match(html, /<mark[^>]*><strong>Highlight<\/strong><\/mark>/);
  assert.match(html, /<u>under<\/u>/);
  assert.match(html, /style="color:#dc2626"/);
  assert.match(html, /data-callout-type="warning"/);
  assert.match(html, /Keep visible/);
  assert.match(html, /!\[\[DOC-1\]\]/);
  assert.match(html, /!\[\[DOC-2\|Other\]\]/);
  assert.match(html, /Historical pm-view/);
  assert.match(html, /query: all/);
  assert.doesNotMatch(html, /<button|<iframe|<img|LIVE VIEW/);
});

test('math and diagrams are atomic; TeX never enables author-controlled network or script actions', () => {
  const change = compare('Formula $x^2$.\n\n$$\na+b\n$$', 'Formula $x^3$.\n\n$$\na-b\n$$').changes.find(item => item.before?.source.startsWith('Formula'))!;
  assert.equal(change.syntaxOnly, true);
  assert.deepEqual(change.beforeRanges, []);
  assert.match(render(change.after!), /class="katex"/);
  const hostile = endpoint('$\\href{javascript:alert(1)}{click}$ $\\includegraphics{https://evil.test/pixel}$').map(block => render(block)).join('');
  assert.doesNotMatch(hostile, /href="javascript:|<img\b|\ssrc=/);
  const diagram = compare('```mermaid\ngraph TD\nA-->B\n```', '```mermaid\ngraph TD\nA-->C\n```').changes[0]!;
  assert.equal(diagram.before?.node?.lang, 'mermaid');
  assert.deepEqual(diagram.beforeRanges, []);
  assert.equal(diagram.syntaxOnly, true);
});

test('AST marking does not mutate immutable snapshot nodes or treat literal code as Markdown', () => {
  const change = compare('Keep `a < b` **old**.', 'Keep `a > b` **new**.').changes[0]!;
  const original = JSON.stringify(change.after);
  const tree = historicalRenderTree(change.after!, change.afterRanges, 'after', 'test');
  assert.equal(JSON.stringify(change.after), original);
  assert.equal(tree.type, 'root');
  const html = render(change.after!, change.afterRanges);
  assert.match(html, /<code[^>]*>a &gt; b<\/code>/);
  assert.match(html, /<strong>/);
});

test('size, block, depth, math, diagram and token complexity bounds select explicit source fallback', () => {
  assert.deepEqual(buildMarkdownDiff('', 'a'.repeat(markdownDiffLimits.characters + 1)), { kind: 'fallback', reason: 'size' });
  assert.deepEqual(buildMarkdownDiff('', 'a'.repeat(markdownDiffLimits.blockCharacters + 1)), { kind: 'fallback', reason: 'structure' });
  assert.deepEqual(buildMarkdownDiff('', Array.from({ length: markdownDiffLimits.blocks + 1 }, (_, index) => `Paragraph ${index}`).join('\n\n')), { kind: 'fallback', reason: 'structure' });
  assert.deepEqual(buildMarkdownDiff('', `${'> '.repeat(markdownDiffLimits.depth + 1)}Nested`), { kind: 'fallback', reason: 'structure' });
  assert.deepEqual(buildMarkdownDiff('', `$${'x'.repeat(markdownDiffLimits.mathCharacters + 1)}$`), { kind: 'fallback', reason: 'structure' });
  assert.deepEqual(buildMarkdownDiff('', Array.from({ length: markdownDiffLimits.diagrams + 1 }, () => '```mermaid\ngraph TD\nA-->B\n```').join('\n\n')), { kind: 'fallback', reason: 'structure' });
  assert.deepEqual(buildMarkdownDiff('', Array.from({ length: markdownDiffLimits.formulas + 1 }, () => '$x$').join(' ')), { kind: 'fallback', reason: 'structure' });
  const repeatedFootnote = `${Array.from({ length: 30 }, (_, index) => `Paragraph ${index}[^n].`).join('\n\n')}\n\n[^n]: ${'a'.repeat(10_000)}`;
  assert.deepEqual(buildMarkdownDiff('', repeatedFootnote), { kind: 'fallback', reason: 'structure' });
  assert.deepEqual(buildMarkdownDiff('a'.repeat(markdownDiffLimits.inlineTokens + 1), 'b'.repeat(markdownDiffLimits.inlineTokens + 1)), { kind: 'fallback', reason: 'complexity' });
});
