import { useEffect, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown as markdownLanguage } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import {
  Bold, Code2, Eye, Heading2, Heading3, Italic, List, ListOrdered, Quote,
  Redo2, Strikethrough, Undo2,
} from 'lucide-react';

const editorTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'visible', fontFamily: 'var(--font-mono, monospace)', lineHeight: '1.7' },
  '.cm-content': { padding: '0', minHeight: '72px' },
  '.cm-line': { padding: '0' },
  '.cm-gutters': { display: 'none' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection)' },
});

function VisualMarkdownEditor({ value, disabled, en, placeholder, onChange }: {
  value: string;
  disabled: boolean;
  en: boolean;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const change = useRef(onChange);
  change.current = onChange;
  const lastEmitted = useRef(value);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false, autolink: false },
        underline: false,
        code: { HTMLAttributes: { spellcheck: 'false' } },
        codeBlock: { HTMLAttributes: { spellcheck: 'false' } },
      }),
      Markdown,
    ],
    content: value,
    contentType: 'markdown',
    editable: !disabled,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': en ? 'Task description' : '任务描述',
        class: 'doc-prose',
      },
    },
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    onUpdate: ({ editor: current }) => {
      const next = current.getMarkdown();
      lastEmitted.current = next;
      change.current(next);
    },
  });
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => current ? {
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      strike: current.isActive('strike'),
      h2: current.isActive('heading', { level: 2 }),
      h3: current.isActive('heading', { level: 3 }),
      bullet: current.isActive('bulletList'),
      ordered: current.isActive('orderedList'),
      quote: current.isActive('blockquote'),
      code: current.isActive('codeBlock'),
      undo: current.can().undo(),
      redo: current.can().redo(),
    } : null,
  });
  useEffect(() => { editor?.setEditable(!disabled); }, [editor, disabled]);
  useEffect(() => {
    if (!editor || value === lastEmitted.current) return;
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
    lastEmitted.current = value;
  }, [editor, value]);
  const tools = [
    { label: en ? 'Heading 2' : '二级标题', active: state?.h2, icon: Heading2, run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: en ? 'Heading 3' : '三级标题', active: state?.h3, icon: Heading3, run: () => editor?.chain().focus().toggleHeading({ level: 3 }).run() },
    { label: en ? 'Bold' : '粗体', active: state?.bold, icon: Bold, run: () => editor?.chain().focus().toggleBold().run() },
    { label: en ? 'Italic' : '斜体', active: state?.italic, icon: Italic, run: () => editor?.chain().focus().toggleItalic().run() },
    { label: en ? 'Strikethrough' : '删除线', active: state?.strike, icon: Strikethrough, run: () => editor?.chain().focus().toggleStrike().run() },
    { label: en ? 'Bullet list' : '无序列表', active: state?.bullet, icon: List, run: () => editor?.chain().focus().toggleBulletList().run() },
    { label: en ? 'Numbered list' : '有序列表', active: state?.ordered, icon: ListOrdered, run: () => editor?.chain().focus().toggleOrderedList().run() },
    { label: en ? 'Quote' : '引用', active: state?.quote, icon: Quote, run: () => editor?.chain().focus().toggleBlockquote().run() },
    { label: en ? 'Code block' : '代码块', active: state?.code, icon: Code2, run: () => editor?.chain().focus().toggleCodeBlock().run() },
  ];
  return <div className="doc-visual" data-focused={focused || undefined}>
    <div className="doc-formatting" role="group" aria-label={en ? 'Markdown formatting' : 'Markdown 格式'}>
      {tools.map(tool => <button key={tool.label} type="button" className="doc-format-button" aria-label={tool.label} title={tool.label} aria-pressed={!!tool.active} disabled={disabled || !editor} onClick={tool.run}>
        <tool.icon size={14} aria-hidden="true" />
      </button>)}
      <span className="doc-format-separator" aria-hidden="true" />
      <button type="button" className="doc-format-button" aria-label={en ? 'Undo' : '撤销'} title={en ? 'Undo' : '撤销'} disabled={disabled || !state?.undo} onClick={() => editor?.chain().focus().undo().run()}><Undo2 size={14} aria-hidden="true" /></button>
      <button type="button" className="doc-format-button" aria-label={en ? 'Redo' : '重做'} title={en ? 'Redo' : '重做'} disabled={disabled || !state?.redo} onClick={() => editor?.chain().focus().redo().run()}><Redo2 size={14} aria-hidden="true" /></button>
    </div>
    <div className="doc-visual-surface">
      <EditorContent editor={editor} />
      {!value.trim() && !focused && <span className="doc-placeholder" aria-hidden="true">{placeholder}</span>}
    </div>
  </div>;
}

/**
 * The visual editor intentionally covers the common Markdown subset. Content
 * that depends on syntax it cannot round-trip (tables, images, checklists,
 * wiki links, raw HTML, math, fenced languages) opens in source mode instead
 * of being silently rewritten.
 */
const visualUnsafe: RegExp[] = [
  /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m,
  /^\s*[-*+]\s+\[[ xX]\]/m,
  /!\[[^\]]*\]\([^)]*\)/,
  /^\s*\[[^\]]+\]:\s+\S+/m,
  /<\/?[a-z][^>]*>/i,
  /\$\$|\\\(|\\\[/,
  /\[\^[^\]]+\]/,
  /^\s*```\s*[^\s`]/m,
  /^>\s*\[!/m,
  /\[\[/,
  /\^[\w-]+\s*$/m,
];

function visualSafe(value: string) {
  return !visualUnsafe.some(pattern => pattern.test(value));
}

/**
 * The document body is stored as Markdown in one place. Visual mode and source
 * mode are two views of that value, never separate task facts.
 */
export function MarkdownBodyEditor({ value, disabled, en, onChange }: {
  value: string;
  disabled: boolean;
  en: boolean;
  onChange: (value: string) => void;
}) {
  const safe = visualSafe(value);
  const [mode, setMode] = useState<'visual' | 'source'>(safe ? 'visual' : 'source');
  useEffect(() => { if (!safe) setMode('source'); }, [safe]);
  const placeholder = en ? 'Write a description. Markdown is preserved.' : '写点什么，支持 Markdown。';
  return <section className="doc-body" aria-label={en ? 'Task description' : '任务描述'}>
    <div className="doc-body-bar">
      <span className="doc-body-label">{en ? 'Description' : '描述'}</span>
      {!safe && <span className="doc-mode-note">{en ? 'Full Markdown kept in source mode' : '已用源码模式保留完整 Markdown'}</span>}
      <div className="doc-body-modes" role="group" aria-label={en ? 'Description editor mode' : '描述编辑模式'}>
        <button type="button" className="doc-mode" data-active={mode === 'visual' || undefined} aria-pressed={mode === 'visual'} disabled={!safe} title={safe ? undefined : (en ? 'This content uses Markdown the visual editor cannot preserve. Use source mode.' : '此内容包含可视化编辑器无法完整保留的 Markdown，请使用源码模式。')} onClick={() => setMode('visual')}><Eye size={12} aria-hidden="true" />{en ? 'Visual' : '可视化'}</button>
        <button type="button" className="doc-mode" data-active={mode === 'source' || undefined} aria-pressed={mode === 'source'} onClick={() => setMode('source')} title={en ? 'Source mode supports the full Markdown syntax' : '源码模式支持完整 Markdown 语法'}><Code2 size={12} aria-hidden="true" />{en ? 'Source' : '源码'}</button>
      </div>
    </div>
    {mode === 'visual'
      ? <VisualMarkdownEditor key="visual" value={value} disabled={disabled} en={en} placeholder={placeholder} onChange={onChange} />
      : <div className="doc-source">
        <CodeMirror
          value={value}
          extensions={[markdownLanguage(), editorTheme]}
          editable={!disabled}
          readOnly={disabled}
          onChange={onChange}
          placeholder={placeholder}
          aria-label={en ? 'Task description source' : '任务描述源码'}
          basicSetup={{
            lineNumbers: false, foldGutter: false, highlightActiveLine: false,
            highlightActiveLineGutter: false, highlightSelectionMatches: false,
          }}
        />
      </div>}
  </section>;
}
