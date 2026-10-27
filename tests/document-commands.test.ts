import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDocumentCommand, documentCommands } from '../apps/web/src/features/pm/markdown/document-commands.ts';
import type { DocumentEdit } from '../apps/web/src/features/pm/markdown/document-editing-types.ts';

function apply(text: string, command: string, input?: string, from = 0, to = text.length) {
  return applyDocumentCommand(text, { from, to }, command, input);
}
function selected(result: DocumentEdit) { return result.text.slice(result.selection.from, result.selection.to); }

const inlineCases: [string, string, string?][] = [
  ['bold', '**word**'], ['italic', '*word*'], ['bolditalic', '***word***'], ['strike', '~~word~~'],
  ['underline', '++word++'], ['superscript', '^word^'], ['subscript', '~word~'], ['formula-inline', '$word$'], ['comment', '%%word%%'],
  ...['red', 'orange', 'yellow', 'green', 'blue', 'purple'].map(color => [`highlight-${color}`, `=={${color}}word==`] as [string, string]),
  ['color', '{color:#1234ab}word{/color}', '#1234ab'], ['font', '{font:mono}word{/font}', 'mono'], ['font-size', '{size:large}word{/size}', 'large'],
];

test('registry has unique reachable IDs and describes real input syntax', () => {
  assert.equal(new Set(documentCommands.map(command => command.id)).size, documentCommands.length);
  for (const [id] of inlineCases) assert.ok(documentCommands.some(command => command.id === id));
  assert.deepEqual(documentCommands.filter(command => command.id.startsWith('highlight-')).map(command => command.id), ['highlight-red', 'highlight-orange', 'highlight-yellow', 'highlight-green', 'highlight-blue', 'highlight-purple']);
  assert.throws(() => apply('word', 'highlight-pink'), /Unknown document command/);
  assert.match(documentCommands.find(command => command.id === 'template')!.input!.labelEn, /template,title,date,time/);
  assert.throws(() => apply('text', 'not-a-command'), /Unknown document command/);
});

test('inline commands edit only the selected bytes and inverse-toggle both returned and marker-inclusive selections', () => {
  for (const [command, formatted, input] of inlineCases) {
    const result = apply('before word after', command, input, 7, 11);
    assert.equal(result.text, `before ${formatted} after`, command);
    assert.equal(selected(result), 'word', command);
    assert.equal(applyDocumentCommand(result.text, result.selection, command, input).text, 'before word after', command);
    assert.equal(apply(formatted, command, input).text, 'word', command);
  }
});

test('empty selections insert editable placeholders rather than a no-op', () => {
  const bold = apply('left right', 'bold', undefined, 5, 5);
  assert.equal(bold.text, 'left **text**right');
  assert.equal(selected(bold), 'text');
  const code = apply('', 'inline-code');
  assert.equal(code.text, '`code`');
  assert.equal(selected(code), 'code');
  for (const [id, , input] of inlineCases) assert.ok(apply('', id, input).text.length > 0, id);
});

test('UTF-16 selection bounds reject reversed, fractional, outside, CRLF-split and surrogate-split ranges', () => {
  for (const selection of [{ from: -1, to: 0 }, { from: 1, to: 0 }, { from: 0, to: 9 }, { from: 0.5, to: 1 }, { from: NaN, to: 1 }]) {
    assert.throws(() => applyDocumentCommand('abc', selection, 'bold'), /UTF-16 range/);
  }
  assert.throws(() => applyDocumentCommand('a\r\nb', { from: 2, to: 2 }, 'bold'), /CRLF/);
  assert.throws(() => applyDocumentCommand('a😀b', { from: 2, to: 2 }, 'bold'), /surrogate/);
  assert.equal(apply('😀', 'bold').text, '**😀**');
});

test('multiline inline formatting retains block markers, blank lines, whitespace and CRLF bytes', () => {
  const text = 'untouched\r\n\r\n# One\r\n- Two  \r\n\r\nuntouched';
  const from = text.indexOf('# One'), to = text.indexOf('\r\n\r\nuntouched', from);
  const result = apply(text, 'bold', undefined, from, to);
  assert.equal(result.text, 'untouched\r\n\r\n# **One**\r\n- **Two**  \r\n\r\nuntouched');
  assert.equal(applyDocumentCommand(result.text, result.selection, 'bold').text, text);
  const plain = apply('one\r\n\r\ntwo', 'italic');
  assert.equal(plain.text, '*one*\r\n\r\n*two*');
  assert.equal(applyDocumentCommand(plain.text, plain.selection, 'italic').text, 'one\r\n\r\ntwo');
  assert.throws(() => apply(' \r\n\t ', 'bold'), /whitespace/);
});

test('AST contexts protect fences, nested fenced blocks, indented code and inline backticks', () => {
  for (const text of ['```md\n**literal**\n```', '~~~md\n# literal\n~~~', '> ```md\n> - literal\n> ```', '    literal']) {
    for (const command of ['bold', 'heading-2', 'task-list', 'clear-formatting', 'code-block']) assert.throws(() => apply(text, command), /code fence|code block/, `${command}: ${text}`);
  }
  const text = 'before `literal` after';
  const from = text.indexOf('literal');
  assert.throws(() => apply(text, 'bold', undefined, from, from + 7), /inline code/);
  assert.equal(apply(text, 'heading-1', undefined, from, from + 7).text, '# before `literal` after');
  assert.throws(() => apply(text, 'inline-code', undefined, from + 1, from + 5), /complete inline code/);
  assert.equal(apply(text, 'inline-code', undefined, from, from + 7).text, 'before literal after');
});

test('body commands never toggle accidentally supplied YAML frontmatter', () => {
  const raw = '---\r\nid: DOC-1\r\nx-note: keep\r\n---\r\n# Title\r\n';
  assert.throws(() => apply(raw, 'bold'), /Frontmatter/);
  assert.throws(() => apply(raw, 'task-list', undefined, raw.indexOf('id:'), raw.indexOf('id:') + 2), /Frontmatter/);
  const from = raw.indexOf('Title');
  assert.equal(apply(raw, 'bold', undefined, from, from + 5).text, raw.replace('Title', '**Title**'));
});

test('inline code chooses safe delimiter lengths and preserves literal backticks and padding', () => {
  for (const content of ['a`b', '`edge', 'edge`', ' a ', '  ', 'a``b']) {
    const result = apply(content, 'inline-code');
    assert.equal(selected(result), content);
    assert.equal(applyDocumentCommand(result.text, result.selection, 'inline-code').text, content);
  }
  assert.equal(apply('`edge', 'inline-code').text, '`` `edge ``');
  assert.throws(() => apply('a\nb', 'inline-code'), /cannot span lines/);
  assert.throws(() => apply('a\nb', 'formula-inline'), /one line/);
});

test('escaping and partial Markdown selections never silently rewrite neighboring syntax', () => {
  assert.equal(apply('a \\*literal\\* z', 'bold', undefined, 2, 13).text, 'a **\\*literal\\*** z');
  assert.throws(() => apply('\\word', 'bold', undefined, 1, 5), /escape/);
  assert.throws(() => apply('word\\', 'bold'), /escape/);
  assert.throws(() => apply('a*b', 'italic'), /unmatched formatting delimiter/);
  assert.throws(() => apply('a==b', 'highlight-yellow'), /unmatched formatting delimiter/);
  assert.throws(() => apply('**word**', 'italic', undefined, 3, 5), /complete formatted span/);
  assert.equal(apply('**word**', 'italic').text, '***word***');
  assert.equal(apply('__word__', 'bold').text, 'word');
  assert.equal(apply('_word_', 'italic').text, 'word');
  assert.throws(() => apply('~~word~~', 'subscript'), /ambiguous delimiter|code fence/);
  assert.throws(() => apply('outer %%inner%% text', 'comment'), /cannot be nested/);
  const nested = apply('**word**', 'italic', undefined, 2, 6);
  assert.equal(nested.text, '***word***');
  assert.equal(applyDocumentCommand(nested.text, nested.selection, 'italic').text, '**word**');
});

test('paragraph transforms operate on whole selected lines without touching following lines', () => {
  for (let depth = 1; depth <= 6; depth++) {
    const command = `heading-${depth}`, prefix = '#'.repeat(depth) + ' ';
    const result = apply('one\r\ntwo\r\nthree', command, undefined, 0, 10);
    assert.equal(result.text, `${prefix}one\r\n${prefix}two\r\nthree`);
    assert.equal(applyDocumentCommand(result.text, result.selection, command).text, 'one\r\ntwo\r\nthree');
  }
  assert.equal(apply('## one\r\n> - [x] two', 'paragraph').text, 'one\r\ntwo');
  assert.throws(() => apply('ordinary', 'paragraph'), /no applicable formatting/);
  assert.throws(() => apply('Title\n=====', 'heading-2'), /setext heading/);
  assert.throws(() => apply('| a | b |\n| - | - |\n| c | d |', 'heading-2'), /table/);
});

test('lists, quotes and indentation support real inverse transforms and keep completed task text', () => {
  for (const [command, expected] of [['ordered-list', '1. one\r\n2. two'], ['unordered-list', '- one\r\n- two'], ['task-list', '- [ ] one\r\n- [ ] two'], ['blockquote', '> one\r\n> two'], ['indent', '  one\r\n  two']]) {
    const result = apply('one\r\ntwo', command!);
    assert.equal(result.text, expected);
    assert.equal(applyDocumentCommand(result.text, result.selection, command === 'indent' ? 'outdent' : command!).text, 'one\r\ntwo');
  }
  assert.equal(apply('- [x] done\n- [ ] later', 'task-list').text, 'done\nlater');
  assert.equal(apply('- [x] done\n- [ ] later', 'ordered-list').text, '1. done\n2. later');
  assert.equal(apply('> > note', 'blockquote').text, '> note');
  assert.throws(() => apply('not indented', 'outdent'), /no applicable formatting/);
  assert.deepEqual(apply('', 'task-list'), { text: '- [ ] ', selection: { from: 6, to: 6 } });
});

test('links and images escape labels and URL delimiters, reject unsafe schemes and insert real wiki syntax', () => {
  const linked = apply('a [label] \\ end', 'link', 'https://example.test/a(b) c?q=x');
  assert.equal(linked.text, '[a \\[label\\] \\\\ end](https://example.test/a%28b%29%20c?q=x)');
  assert.equal(apply('alt', 'image', '/files/my image.png').text, '![alt](/files/my%20image.png)');
  assert.equal(apply('Email', 'link', 'mailto:person@example.test').text, '[Email](mailto:person@example.test)');
  for (const url of ['javascript:alert(1)', 'data:text/html,test', '//example.test/path', 'https://', 'https://ok\nwrong']) assert.throws(() => apply('text', 'link', url), /URL|HTTP/);
  assert.throws(() => apply('text', 'image', 'mailto:x@example.test'), /HTTP/);
  assert.equal(apply('Display', 'internal-link', 'DOC-123#Heading').text, '[[DOC-123#Heading|Display]]');
  assert.equal(apply('', 'internal-link', 'TASK-123|Task').text, '[[TASK-123|Task]]');
  assert.equal(apply('', 'document-embed', 'DOC-123#^block').text, '![[DOC-123#^block]]');
  assert.throws(() => apply('', 'internal-link', 'bad]]target'), /single note/);
});

test('block starters use the document newline and isolate insertion from untouched adjacent prose', () => {
  const text = 'before\r\nafter';
  const result = apply(text, 'code-block', 'typescript', 8, 8);
  assert.equal(result.text, 'before\r\n\r\n```typescript\r\ncode\r\n```\r\n\r\nafter');
  assert.equal(selected(result), 'code');
  const withTicks = apply('a``b', 'code-block', 'md');
  assert.equal(withTicks.text, '```md\na``b\n```');
  assert.equal(selected(withTicks), 'a``b');
  assert.equal(apply('a```b', 'code-block', 'md').text, '````md\na```b\n````');
  assert.throws(() => apply('', 'code-block', 'js\n```'), /language identifier/);
  const codeContent = apply('before `literal` after', 'code-block', 'md');
  assert.equal(codeContent.text, '```md\nbefore `literal` after\n```');
  assert.equal(apply('', 'horizontal-rule').text, '---');
  assert.equal(apply('', 'table').text, '| Column 1 | Column 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |');
  assert.equal(apply('line one\r\nline two', 'callout', 'warning|Read me').text, '> [!WARNING] Read me\r\n> line one\r\n> line two');
  assert.equal(apply('', 'formula-block').text, '$$\nx^2\n$$');
  assert.equal(apply('', 'mermaid').text, '```mermaid\nflowchart TD\n  A[Start] --> B[End]\n```');
  assert.throws(() => apply('x\n$$\ny', 'formula-block'), /delimiter/);
});

test('footnotes allocate unused IDs and append definitions without replacing existing body bytes', () => {
  const text = 'Keep[^1].\r\n\r\n[^1]: Existing\r\n\r\nnew note';
  const from = text.indexOf('new note');
  const result = apply(text, 'footnote', '', from, text.length);
  assert.equal(result.text, 'Keep[^1].\r\n\r\n[^1]: Existing\r\n\r\n[^2]\r\n\r\n[^2]: new note\r\n');
  assert.equal(result.selection.from, result.selection.to);
  assert.throws(() => apply(text, 'footnote', '1', from, text.length), /already in use/);
  assert.equal(apply('one\ntwo', 'footnote', 'note').text, '[^note]\n\n[^note]: one\n    two\n');
  assert.throws(() => apply('note\n\n```\nunclosed', 'footnote', 'closed', 0, 4), /hide the footnote/);
  const duplicate = 'ref[^note]\n\n[^note]: old\n\nnew';
  assert.throws(() => apply(duplicate, 'footnote', 'NOTE', duplicate.length - 3, duplicate.length), /already in use/);
});

test('tags validate names and boundaries instead of breaking an adjacent word', () => {
  assert.equal(apply('', 'tag', '项目/编辑器').text, '#项目/编辑器');
  assert.equal(apply('editor', 'tag').text, '#editor');
  assert.throws(() => apply('word', 'tag', 'tag', 2, 2), /word boundary/);
  for (const input of ['a b', '123', 'x]y']) assert.throws(() => apply('', 'tag', input), /tag needs/);
});

test('safe enhanced styles use only the renderer whitelist and never insert arbitrary HTML/CSS', () => {
  for (const [command, value] of [['color', 'url(javascript:x)'], ['color', '#abc'], ['font', 'Comic Sans'], ['font-size', '99px']]) assert.throws(() => apply('word', command!, value), /Unsupported/);
  assert.equal(apply('word', 'color', 'red').text, '{color:red}word{/color}');
  assert.equal(apply('word', 'color', 'orange').text, '{color:orange}word{/color}');
  assert.equal(apply('word', 'color', 'pink').text, '{color:pink}word{/color}');
  assert.equal(apply('word', 'font', 'serif').text, '{font:serif}word{/font}');
});

test('clear formatting follows AST bounds and removes nested safe styles without touching escaped markers', () => {
  assert.equal(apply('# **bold** and *italic* with ~~gone~~ and `code`', 'clear-formatting').text, 'bold and italic with gone and code');
  assert.equal(apply('[**Label**](https://example.test) ![Alt](/file.png)', 'clear-formatting').text, 'Label Alt');
  assert.equal(apply('++one++ =={yellow}two== {font:mono}three{/font}', 'clear-formatting').text, 'one two three');
  assert.equal(apply('{color:red}++nested++{/color}', 'clear-formatting').text, 'nested');
  assert.equal(apply('=={orange}text==', 'clear-formatting').text, 'text');
  assert.equal(apply('~sub~ and ^sup^', 'clear-formatting').text, 'sub and sup');
  assert.equal(apply('before **word** after', 'clear-formatting', undefined, 9, 13).text, 'before word after');
  assert.equal(apply('before \\*literal\\* **bold** after', 'clear-formatting').text, 'before \\*literal\\* bold after');
  assert.throws(() => apply('plain text', 'clear-formatting'), /no applicable formatting/);
});

test('templates expand explicit deterministic variables and derive the authoritative body H1 title', () => {
  const text = '# **Existing** title\r\n\r\nBody';
  const input = JSON.stringify({ template: '## {{title}}\nDate {{date}} at {{time}}', title: 'Chosen title', date: '2026-10-22', time: '13:05' });
  const first = apply(text, 'template', input, text.length, text.length);
  const second = apply(text, 'template', input, text.length, text.length);
  assert.deepEqual(first, second);
  assert.equal(first.text, text + '\r\n\r\n## Chosen title\r\nDate 2026-10-22 at 13:05');
  assert.equal(apply(text, 'template', '{{title}}', text.length, text.length).text, text + '\r\n\r\nExisting title');
  assert.equal(apply('', 'template', 'Plain template').text, 'Plain template');
  assert.throws(() => apply('', 'template', '{{date}}'), /explicit value/);
  assert.throws(() => apply('', 'template', '{{time}}'), /explicit value/);
  assert.throws(() => apply('', 'template', '{"template":4}'), /template string/);
  assert.throws(() => apply('', 'template', JSON.stringify({ template: '{{title}}', title: 3 })), /must be a string/);
});
