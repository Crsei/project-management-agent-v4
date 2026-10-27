import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStructureCommand,
  documentStructureCommandReason,
  documentStructureCommandReasons,
  scanDocumentBlocks,
  scanDocumentOutline,
  structureCommands,
} from '../apps/web/src/features/pm/markdown/document-structure.ts';

function edit(text: string, needle: string, command: string, input?: string) {
  const at = text.indexOf(needle);
  assert.notEqual(at, -1, `Missing fixture selection: ${needle}`);
  return applyStructureCommand(text, { from: at, to: at }, command, input);
}

const table = '| Name | Count |\n| :--- | ---: |\n| beta | 10 |\n| alpha | 2 |';

test('structure registry exposes real, unique commands and rejects unknown IDs and invalid UTF-16 selections', () => {
  assert.equal(new Set(structureCommands.map(command => command.id)).size, structureCommands.length);
  assert.ok(structureCommands.every(command => command.label && command.labelEn));
  assert.throws(() => applyStructureCommand('body', { from: 0, to: 0 }, 'not-a-command'), /Unknown structure command/);
  for (const selection of [{ from: -1, to: 0 }, { from: 2, to: 1 }, { from: 0, to: 5 }, { from: 0.5, to: 1 }]) {
    assert.throws(() => applyStructureCommand('body', selection, 'block-delete'), /Invalid document selection/);
  }
});

test('table row insertion uses the header context without inserting before its delimiter', () => {
  assert.equal(edit(table, 'Name', 'table-row-add-after').text,
    '| Name | Count |\n| :--- | ---: |\n| | |\n| beta | 10 |\n| alpha | 2 |');
  assert.equal(edit(table, 'alpha', 'table-row-add-before').text,
    '| Name | Count |\n| :--- | ---: |\n| beta | 10 |\n| | |\n| alpha | 2 |');
  assert.equal(edit(table, 'alpha', 'table-row-add-after').text,
    `${table}\n| | |`);
  assert.throws(() => edit(table, 'Name', 'table-row-add-before'), /cannot precede the header/);
  assert.throws(() => edit(table, ':---', 'table-row-add-before'), /cannot precede the header/);
});

test('table body row moves and deletes preserve header, escaped pipes, inline code, and outside bytes', () => {
  const head = '# Keep  \r\n\r\n'; const tail = '\r\n\r\nUntouched **tail**  \r\n';
  const source = '| A | B |\r\n| --- | --- |\r\n| one \\| two | `a\\|b` |\r\n| last | ``x`y`` |';
  const raw = head + source + tail;
  const moved = edit(raw, 'last', 'table-row-move-up');
  assert.equal(moved.text, head + '| A | B |\r\n| --- | --- |\r\n| last | ``x`y`` |\r\n| one \\| two | `a\\|b` |' + tail);
  assert.equal(edit(moved.text, 'last', 'table-row-move-down').text, raw);
  assert.equal(edit(raw, 'last', 'table-row-delete').text,
    head + '| A | B |\r\n| --- | --- |\r\n| one \\| two | `a\\|b` |' + tail);
  const onlyBody = '| A |\n| --- |\n| value |';
  assert.equal(edit(onlyBody, 'value', 'table-row-delete').text, '| A |\n| --- |');
});

test('table row and column boundaries reject explicitly instead of reporting success', () => {
  for (const command of ['table-row-delete', 'table-row-move-up', 'table-row-move-down']) {
    assert.throws(() => edit(table, 'Name', command), /header and delimiter/);
  }
  assert.throws(() => edit(table, 'beta', 'table-row-move-up'), /boundary/);
  assert.throws(() => edit(table, 'alpha', 'table-row-move-down'), /boundary/);
  assert.throws(() => edit(table, 'Name', 'table-column-move-left'), /boundary/);
  assert.throws(() => edit(table, 'Count', 'table-column-move-right'), /boundary/);
  assert.throws(() => edit('| A |\n| --- |', 'A', 'table-column-delete'), /at least one column/);
  const from = table.indexOf('beta'); const to = table.indexOf('alpha') + 2;
  assert.throws(() => applyStructureCommand(table, { from, to }, 'table-row-delete'), /single table row/);
});

test('table columns insert, move, and delete whole raw cells including escaped pipes and code', () => {
  const source = '| A | B |\n| --- | ---: |\n| one \\| two | `a\\|b` |';
  const before = edit(source, 'B |', 'table-column-add-before').text;
  assert.equal(before, '| A | | B |\n| --- | --- | ---: |\n| one \\| two | | `a\\|b` |');
  const after = edit(source, 'A |', 'table-column-add-after').text;
  assert.equal(after, before);
  const moved = edit(source, 'B |', 'table-column-move-left').text;
  assert.equal(moved, '| B | A |\n| ---: | --- |\n| `a\\|b` | one \\| two |');
  assert.equal(edit(moved, 'B |', 'table-column-move-right').text, source);
  assert.equal(edit(source, 'B |', 'table-column-delete').text,
    '| A |\n| --- |\n| one \\| two |');
});

test('deleting a pipe-less table down to one column keeps it parseable as a table', () => {
  const result = edit('A | B\n--- | ---\none | two', 'A |', 'table-column-delete');
  assert.equal(result.text, '| B|\n| ---|\n| two|');
  assert.deepEqual(scanDocumentBlocks(result.text).map(block => block.kind), ['table']);
  assert.throws(() => edit(result.text, 'B', 'table-column-delete'), /at least one column/);
});

test('column alignment changes only the current delimiter cell, without filling implicit body cells', () => {
  const source = '| A | B |\n| --- | --- |\n| only |';
  const center = edit(source, 'B |', 'table-align-center').text;
  assert.equal(center, '| A | B |\n| --- | :---: |\n| only |');
  assert.equal(edit(center, 'B |', 'table-align-right').text, '| A | B |\n| --- | ---: |\n| only |');
  assert.equal(edit(center, 'B |', 'table-align-left').text, '| A | B |\n| --- | :--- |\n| only |');
  assert.equal(edit(center, 'B |', 'table-align-none').text, source);
  assert.throws(() => edit(center, 'B |', 'table-align-center'), /already has this alignment/);
  const inserted = edit(source, 'B |', 'table-column-add-after').text;
  assert.equal(inserted, '| A | B | |\n| --- | --- | --- |\n| only | | |');
});

test('table sorting is stable, natural, and body-only; insufficient and already sorted inputs reject', () => {
  const source = '| Label | Count |\n| :---: | ---: |\n| ten | 10 |\n| first two | 2 |\n| second two | 2 |\n| one | 1 |';
  const result = edit(source, 'Count', 'table-sort-ascending');
  assert.equal(result.text, '| Label | Count |\n| :---: | ---: |\n| one | 1 |\n| first two | 2 |\n| second two | 2 |\n| ten | 10 |');
  const descending = edit(result.text, 'Count', 'table-sort-descending');
  assert.equal(descending.text, '| Label | Count |\n| :---: | ---: |\n| ten | 10 |\n| first two | 2 |\n| second two | 2 |\n| one | 1 |');
  assert.throws(() => edit(result.text, 'Count', 'table-sort-ascending'), /already have this sort order/);
  assert.throws(() => edit('| A |\n| --- |\n| one |', 'A', 'table-sort-ascending'), /at least two body rows/);
});

test('quoted GFM tables retain container prefixes and can be edited without touching adjacent quotes', () => {
  const source = 'before\n\n> | A | B |\n> | --- | --- |\n> | one | two |\n\nafter';
  assert.equal(edit(source, 'B |', 'table-column-add-after').text,
    'before\n\n> | A | B | |\n> | --- | --- | --- |\n> | one | two | |\n\nafter');
  assert.equal(edit(source, 'one', 'table-row-add-after').text,
    'before\n\n> | A | B |\n> | --- | --- |\n> | one | two |\n> | | |\n\nafter');
});

test('extra body cells are not silently discarded during structural editing', () => {
  const source = '| A | B |\n| --- | --- |\n| one | two | extra |';
  assert.throws(() => edit(source, 'one', 'table-column-delete'), /extra cells/);
});

test('fenced examples cannot be mistaken for tables, callouts, images, or outline headings', () => {
  const literal = '````md\n# Fake\n| A | B |\n| --- | --- |\n| one | two |\n```\n> [!NOTE] Fake\n![literal](image.png)\n````';
  const source = literal + '\n\n# Real\n';
  assert.deepEqual(scanDocumentOutline(source).map(heading => heading.title), ['Real']);
  assert.deepEqual(scanDocumentBlocks(source).map(block => block.kind), ['code', 'heading']);
  assert.throws(() => edit(source, 'one', 'table-row-delete'), /one GFM table/);
  assert.throws(() => edit(source, 'Fake\n![', 'callout-title', 'New'), /selection in a callout/);
  assert.throws(() => edit(source, 'literal', 'image-dimensions', '300'), /Markdown image/);
  assert.equal(edit(source, 'one', 'code-language', 'typescript').text,
    source.replace('````md', '````typescript'));
  const unclosed = '~~~md\n# Not a heading\n| A |\n| --- |\n';
  assert.deepEqual(scanDocumentOutline(unclosed), []);
  assert.equal(scanDocumentBlocks(unclosed).length, 1);
});

test('language changes preserve fence length, nested fences, info metadata, CRLF, and surrounding bytes', () => {
  const source = 'before\r\n\r\n~~~~js title="demo"\r\n```\r\nconst x = 1;\r\n```\r\n~~~~\r\n\r\nafter';
  assert.equal(edit(source, 'const x', 'code-language', 'ts').text,
    source.replace('~~~~js title="demo"', '~~~~ts title="demo"'));
  assert.throws(() => edit(source, 'const x', 'code-language', ''), /Remove fence metadata/);
  assert.throws(() => edit(source, 'const x', 'code-language', 'ts injected'), /language identifier/);
  assert.throws(() => edit('    const x = 1;\n', 'const x', 'code-language', 'ts'), /Indented code/);
  assert.equal(edit('```js\nx\n```', 'x\n', 'code-language', '').text, '```\nx\n```');
});

test('callout edits change the metadata line only, including collapse states and empty titles', () => {
  const source = 'before\r\n\r\n> [!NOTE]- Original\r\n> **Body**\r\n>\r\n> More\r\n\r\nafter';
  const typed = edit(source, '**Body**', 'callout-type', 'risk').text;
  assert.equal(typed, source.replace('[!NOTE]', '[!RISK]'));
  const titled = edit(typed, '**Body**', 'callout-title', 'New title').text;
  assert.equal(titled, typed.replace('Original', 'New title'));
  const expanded = edit(titled, '**Body**', 'callout-collapse').text;
  assert.equal(expanded, titled.replace('[!RISK]-', '[!RISK]+'));
  const fixed = edit(expanded, '**Body**', 'callout-collapse', 'none').text;
  assert.equal(fixed, expanded.replace('[!RISK]+', '[!RISK]'));
  assert.equal(edit(fixed, '**Body**', 'callout-collapse', 'collapsed').text, fixed.replace('[!RISK]', '[!RISK]-'));
  assert.equal(edit(titled, '**Body**', 'callout-collapse', 'expanded').text, expanded);
  assert.equal(edit(titled, '**Body**', 'callout-title', '').text, titled.replace(' Original', '').replace(' New title', ''));
  assert.throws(() => edit(source, '**Body**', 'callout-type', 'bad type'), /Callout type/);
  assert.throws(() => edit(source, '**Body**', 'callout-title', 'two\nlines'), /one line/);
  assert.throws(() => edit(source, '**Body**', 'callout-collapse', 'maybe'), /Use toggle/);
  assert.throws(() => edit('> ordinary quote', 'quote', 'callout-type', 'NOTE'), /selection in a callout/);
});

test('image dimensions preserve destinations, titles, escaped alt brackets and explicit references', () => {
  const source = 'before ![a \\] [nested] image|320](https://example.test/a_(b).png "Title") after';
  assert.equal(edit(source, 'nested', 'image-dimensions', '640x480').text,
    source.replace('image|320', 'image|640x480'));
  assert.equal(edit(source, 'nested', 'image-dimensions', '').text, source.replace('image|320', 'image'));
  const reference = '![alt][asset]\n\n[asset]: /image.png "Title"';
  assert.equal(edit(reference, 'alt', 'image-dimensions', '200').text, reference.replace('![alt]', '![alt|200]'));
  const shortcut = '![asset]\n\n[asset]: /image.png';
  assert.throws(() => edit(shortcut, 'asset', 'image-dimensions', '200'), /explicit reference label/);
  for (const input of ['0', '4097', '40x0', '10x20x30', '20%', '1.5']) {
    assert.throws(() => edit(source, 'nested', 'image-dimensions', input), /each 1–4096/);
  }
});

test('block scanning keeps multi-line lists, quotes, and nested fences intact', () => {
  const source = '\n\n# Title\n\n- one\n  continuation\n- two\n\n> quote\n> second\n\n````md\n```\n# literal\n```\n````';
  const blocks = scanDocumentBlocks(source);
  assert.deepEqual(blocks.map(block => block.kind), ['heading', 'list', 'blockquote', 'code']);
  assert.equal(source.slice(blocks[1]!.from, blocks[1]!.to), '- one\n  continuation\n- two');
  assert.equal(source.slice(blocks[3]!.from, blocks[3]!.to), '````md\n```\n# literal\n```\n````');
  assert.equal(blocks[0]!.from, 2);
});

test('block move, duplicate, and delete preserve outside bytes, gaps, caret, and final-newline state', () => {
  const source = 'first  \r\ncontinued\r\n\r\n\r\n> second\r\n> continuation\r\n\r\nlast';
  const moved = edit(source, 'second', 'block-move-up');
  assert.equal(moved.text, '> second\r\n> continuation\r\n\r\n\r\nfirst  \r\ncontinued\r\n\r\nlast');
  assert.equal(moved.text.slice(moved.selection.from, moved.selection.from + 6), 'second');
  assert.equal(edit(moved.text, 'second', 'block-move-down').text, source);
  assert.equal(edit(source, 'second', 'block-duplicate').text,
    source.replace('> second\r\n> continuation', '> second\r\n> continuation\r\n\r\n> second\r\n> continuation'));
  assert.equal(edit(source, 'second', 'block-delete').text,
    source.replace('> second\r\n> continuation', ''));
  assert.equal(edit('last\n', 'last', 'block-duplicate').text, 'last\n\nlast\n');
  assert.equal(edit('last', 'last', 'block-duplicate').text, 'last\n\nlast');
  assert.throws(() => edit(source, 'first', 'block-move-up'), /document boundary/);
  assert.throws(() => edit(source, 'last', 'block-move-down'), /document boundary/);
  assert.throws(() => applyStructureCommand(source, { from: 0, to: source.length }, 'block-delete'), /one content block/);
});

test('supported block conversions retain multi-line content and use safe fences', () => {
  const source = 'before\r\n\r\nalpha\r\nbeta\r\n\r\nafter';
  const quoted = edit(source, 'alpha', 'block-quote').text;
  assert.equal(quoted, source.replace('alpha\r\nbeta', '> alpha\r\n> beta'));
  assert.equal(edit(quoted, 'alpha', 'block-paragraph').text, source);
  const callout = edit(source, 'alpha', 'block-callout', 'TIP|Useful').text;
  assert.equal(callout, source.replace('alpha\r\nbeta', '> [!TIP] Useful\r\n> alpha\r\n> beta'));
  assert.equal(edit(callout, 'alpha', 'block-paragraph').text, source.replace('alpha\r\nbeta', 'Useful\r\nalpha\r\nbeta'));
  assert.throws(() => edit(callout, 'alpha', 'block-callout', 'NOTE'), /already a callout/);
  assert.throws(() => edit(source, 'alpha', 'block-heading', '2'), /single-line content/);
  assert.equal(edit('## Heading ##\n', 'Heading', 'block-paragraph').text, 'Heading\n');
  assert.equal(edit('Heading\n=======\n', 'Heading', 'block-paragraph').text, 'Heading\n');
  assert.equal(edit('Heading', 'Heading', 'block-heading', '6').text, '###### Heading');
  const code = edit('alpha ``` beta\ncontinued', 'alpha', 'block-code', 'ts').text;
  assert.equal(code, '````ts\nalpha ``` beta\ncontinued\n````');
  assert.equal(edit(code, 'alpha', 'block-paragraph').text, 'alpha ``` beta\ncontinued');
  assert.equal(edit('- one\n- two', 'one', 'block-code', 'md').text, '```md\n- one\n- two\n```');
  assert.throws(() => edit('- one\n- two', 'one', 'block-paragraph'), /Convert only/);
});

test('inline annotations persist Markdown, keep selected text, and never invent a thread or identity', () => {
  const source = 'prefix 😀 selected suffix'; const from = source.indexOf('selected'); const to = from + 'selected'.length;
  const result = applyStructureCommand(source, { from, to }, 'annotation-insert', 'Review this');
  assert.equal(result.text, 'prefix 😀 selected %% Review this %% suffix');
  assert.equal(result.text.slice(result.selection.from, result.selection.to), 'Review this');
  assert.equal(edit('word', 'word', 'annotation-insert', 'note').text, '%% note %% word');
  assert.throws(() => edit('word', 'word', 'annotation-insert', ''), /single-line annotation/);
  assert.throws(() => edit('word', 'word', 'annotation-insert', 'bad %% delimiter'), /single-line annotation/);
  for (const source of ['`literal`', '```md\nliteral\n```', '[literal](https://example.test)', '![literal](/image.png)']) {
    assert.throws(() => edit(source, 'literal', 'annotation-insert', 'note'), /inside code, HTML, links, or images/);
  }
  assert.throws(() => edit('%% hidden %%', 'hidden', 'annotation-insert', 'note'), /existing annotation/);
});

test('annotations reject fence endpoints and whitespace inside an existing hidden comment', () => {
  const source = '```md\nliteral\n```';
  for (const at of [0, source.length]) {
    assert.throws(() => applyStructureCommand(source, { from: at, to: at }, 'annotation-insert', 'note'), /inside code/);
  }
  const hidden = '%% hidden   content %%';
  const at = hidden.indexOf('   ') + 1;
  assert.throws(() => applyStructureCommand(hidden, { from: at, to: at }, 'annotation-insert', 'note'), /existing annotation/);
});

test('image dimension pipes are escaped inside tables without changing literal alt escapes elsewhere', () => {
  const source = '| Image | Other |\n| --- | --- |\n| ![alt](/image.png) | keep |';
  const sized = edit(source, 'alt', 'image-dimensions', '640x480').text;
  assert.equal(sized, source.replace('![alt]', '![alt\\|640x480]'));
  assert.equal(edit(sized, 'alt', 'image-dimensions', '320').text, source.replace('![alt]', '![alt\\|320]'));
  assert.equal(edit(sized, 'alt', 'image-dimensions', '').text, source);
  assert.equal(edit(sized, 'Other', 'table-column-move-left').text,
    '| Other | Image |\n| --- | --- |\n| keep | ![alt\\|640x480](/image.png) |');
  assert.equal(edit('![literal\\|64](/image.png)', 'literal', 'image-dimensions', '200').text,
    '![literal\\|64|200](/image.png)');
});

test('hidden annotations cannot become outline headings or structural tables', () => {
  const source = '# Real\n\n%%\n# Hidden\n| A |\n| --- |\n%%\n\n## Visible';
  assert.deepEqual(scanDocumentOutline(source).map(entry => [entry.level, entry.title]), [[1, 'Real'], [2, 'Visible']]);
  assert.throws(() => edit(source, '| A |', 'table-column-add-after'), /one GFM table/);
});

test('contextual command reasons match object applicability and table boundaries', () => {
  const at = table.indexOf('beta'); const reasons = documentStructureCommandReasons(table, { from: at, to: at });
  assert.equal(reasons['table-row-add-before'], null);
  assert.match(reasons['table-row-move-up']!, /boundary/);
  assert.match(reasons['table-column-move-left']!, /boundary/);
  assert.match(reasons['callout-type']!, /callout/);
  assert.match(reasons['code-language']!, /fenced code/);
  assert.match(reasons['image-dimensions']!, /Markdown image/);
  assert.equal(reasons['block-code'], null);
  assert.match(documentStructureCommandReason('ordinary', { from: 1, to: 1 }, 'table-row-delete')!, /one GFM table/);
  assert.match(documentStructureCommandReason('ordinary', { from: 1, to: 1 }, 'unknown')!, /Unknown structure command/);
  assert.match(documentStructureCommandReason('ordinary', { from: -1, to: 1 }, 'block-delete')!, /Invalid document selection/);
});
