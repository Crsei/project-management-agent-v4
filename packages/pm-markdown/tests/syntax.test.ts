import test from 'node:test';
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { createMarkdown, enhanceMarkdownTree, imageDimensions, inspectMarkdown, maskHiddenComments, parseMarkdown, patchMarkdown, titleLineIndex, type SyntaxNode } from '../index.ts';

function source(body: string) { return `---\nschema: pm/v1\nid: DOC-1\nentity: document\nx-preserve: [one, two]\n---\n${body}`; }
function tree(body: string): SyntaxNode {
  const masked = maskHiddenComments(body);
  const result = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath).parse(masked) as SyntaxNode;
  enhanceMarkdownTree(result, masked);
  return result;
}
function nodes(root: SyntaxNode, predicate: (node: SyntaxNode) => boolean): SyntaxNode[] {
  return [...(predicate(root) ? [root] : []), ...(root.children ?? []).flatMap(child => nodes(child, predicate))];
}

test('hidden comments preserve exact UTF-16 offsets and checklist source lines but do not create titles, links or views', () => {
  const body = '%%\r\n# Hidden title\r\n[[SECRET]]\r\n- [ ] Hidden task\r\n```pm-view\r\nnot: valid\r\n```\r\n%%\r\n# ==Visible== title\r\n\r\n- [ ] Visible [[DOC-2|note]]\r\n\r\n%% hidden 😀 line %%\r\n';
  const masked = maskHiddenComments(body);
  assert.equal(masked.length, body.length);
  assert.deepEqual([...masked.matchAll(/\r?\n/g)].map(match => match.index), [...body.matchAll(/\r?\n/g)].map(match => match.index));
  const raw = source(body); const entity = parseMarkdown(raw);
  assert.equal(entity.title, 'Visible title');
  assert.equal(inspectMarkdown(raw).title, entity.title);
  assert.deepEqual(entity.links, ['DOC-2']);
  assert.deepEqual(entity.views, []);
  assert.equal(entity.body, body);
  assert.equal(entity.checklist.length, 1);
  assert.equal(entity.checklist[0]!.text, 'Visible note');
  assert.equal(raw.split('\n')[entity.checklist[0]!.line - 1], '- [ ] Visible [[DOC-2|note]]\r');
  assert.equal(raw.split('\n')[titleLineIndex(raw)!], '# ==Visible== title\r');
});

test('code and math remain literal and never contribute wiki relationships or hidden checklist entries', () => {
  const body = '# Title\n\n`%% [[INLINE]] %%`\n\n```md\n%% [[FENCED]] %%\n- [ ] Code task\n```\n\n$[[FORMULA]]$\n\n$$\n[[BLOCK-MATH]]\n- [ ] Not a task\n$$\n\n\\%% literal percent\n\n![[DOC-2#Heading|Embed]] [[DOC-3#^block|Link]]\n';
  const entity = parseMarkdown(source(body));
  assert.deepEqual(entity.links, ['DOC-2', 'DOC-3']);
  assert.deepEqual(entity.checklist, []);
  const literal = nodes(tree(body), node => node.type === 'inlineCode' || node.type === 'code');
  assert.equal(literal[0]!.value, '%% [[INLINE]] %%');
  assert.ok(literal[1]!.value!.includes('%% [[FENCED]] %%'));
  assert.equal(nodes(tree(body), node => node.type === 'inlineMath').length, 1);
  assert.equal(nodes(tree(body), node => node.type === 'math').length, 1);
});

test('all highlights and whitelisted inline styles build semantic nodes, including nested Markdown', () => {
  const colors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
  const body = `==default== ${colors.map(color => `=={${color}}${color}==`).join(' ')} ++under++ ^super^ ~sub~ ~~deleted~~ {color:#123abc}colored{/color} {font:mono}font{/font} {size:large}large{/size} ==**bold**==`;
  const result = tree(body);
  const styles = nodes(result, node => node.type === 'workspaceStyle');
  assert.equal(styles.filter(node => node.data?.hName === 'mark').length, 8);
  assert.deepEqual(styles.filter(node => node.data?.hName === 'mark').slice(1, 7).map(node => node.data?.hProperties?.className), colors.map(color => `md-highlight md-highlight-${color}`));
  assert.equal(styles.filter(node => node.data?.hName === 'u').length, 1);
  assert.equal(styles.filter(node => node.data?.hName === 'sup').length, 1);
  assert.equal(styles.filter(node => node.data?.hName === 'sub').length, 1);
  assert.equal(nodes(result, node => node.type === 'delete').length, 1);
  assert.ok(styles.some(node => node.data?.hProperties?.style === 'color:#123abc'));
  assert.ok(styles.some(node => node.data?.hProperties?.className === 'md-font-mono'));
  assert.ok(styles.some(node => node.data?.hProperties?.className === 'md-size-large'));
  assert.ok(styles.some(node => node.data?.hName === 'mark' && node.children?.some(child => child.type === 'strong')));
});

test('unapproved CSS and escaped extensions stay literal, including escaped wiki references', () => {
  const result = tree('\\==literal== \\++literal++ \\^literal^ \\~literal~ \\{color:red}literal{/color} \\[[DOC-SECRET]] {color:red;background:url(https://evil.example)}bad{/color} {font:javascript}bad{/font} {size:999px}bad{/size}');
  assert.equal(nodes(result, node => node.type === 'workspaceStyle').length, 0);
  const links = nodes(result, node => node.type === 'link');
  assert.equal(links.filter(node => node.data?.hProperties?.['data-entity-target'] !== undefined).length, 0);
  // Rejected style syntax is literal Markdown, so GFM may still autolink its visible URL.
  assert.equal(links.length, 1);
  assert.ok(links[0]!.url?.startsWith('https://evil.example'));
  assert.deepEqual(parseMarkdown(source('# Visible\n\n\\[[DOC-SECRET]] [broken](#entity:%ZZ)')).links, []);
});

test('image dimensions are bounded and escaped alt pipes are contextual inside GFM tables only', () => {
  assert.deepEqual(imageDimensions('diagram|640x480'), { alt: 'diagram', width: 640, height: 480 });
  assert.deepEqual(imageDimensions('diagram|320'), { alt: 'diagram', width: 320 });
  for (const value of ['diagram|0', 'diagram|4097', 'diagram|10x0', 'diagram|2x9999', 'diagram|20px']) assert.deepEqual(imageDimensions(value), { alt: value });
  const result = tree('![plain|640x480](https://example.test/a.png)\n\n![literal\\|640](https://example.test/a.png)\n\n| Image |\n| --- |\n| ![table\\|320x200](https://example.test/a.png) |');
  const images = nodes(result, node => node.type === 'image');
  assert.deepEqual(images.map(node => [node.alt, node.data?.hProperties?.width, node.data?.hProperties?.height]), [['plain', 640, 480], ['literal|640', undefined, undefined], ['table', 320, 200]]);
});

test('title patches retain unknown YAML/body bytes and newly introduced delimiters remain literal title text', () => {
  const raw = source('# Old\n\n%%private%%\n\n- [ ] Task\n');
  const title = '==literal== ++title++ ^up^ ~down~ %%comment%% $x$ [[DOC-2]]';
  const patched = patchMarkdown(raw, { title });
  assert.equal(parseMarkdown(patched).title, title);
  assert.deepEqual(parseMarkdown(patched)['x-preserve'], ['one', 'two']);
  assert.equal(patched.slice(patched.indexOf('\n\n%%private%%')), raw.slice(raw.indexOf('\n\n%%private%%')));
  assert.equal(parseMarkdown(createMarkdown({ id: 'DOC-3', entity: 'document', title })).title, title);
});

test('paragraph block identifiers are metadata rather than visible checklist text, and escaped identifiers remain text', () => {
  const entity = parseMarkdown(source('# Title\n\n- [ ] Task ^task-id\n\n- [ ] Literal \\^not-an-id\n'));
  assert.deepEqual(entity.checklist.map(item => item.text), ['Task', 'Literal ^not-an-id']);
  const result = tree('Paragraph ^block-id\n\nLiteral \\^not-id');
  assert.equal(nodes(result, node => node.data?.hProperties?.['data-block-id'] === 'block-id').length, 1);
  assert.equal(nodes(result, node => node.data?.hProperties?.['data-block-id'] === 'not-id').length, 0);
});

test('escaped extensions remain literal after entity decoding and quote prefixes without corrupting private-use Unicode', () => {
  const result = tree('&amp; \\==literal==\n\n> quote &amp; \\++literal++\n> and \\[[DOC-SECRET]]\n\n\uE0000\uE001 &#xE000;0&#xE001; ==visible==');
  assert.equal(nodes(result, node => node.type === 'workspaceStyle').length, 1);
  assert.equal(nodes(result, node => node.type === 'link').length, 0);
  const text = nodes(result, node => node.type === 'text').map(node => node.value).join('');
  assert.ok(text.includes('\uE0000\uE001 \uE0000\uE001'));
});
