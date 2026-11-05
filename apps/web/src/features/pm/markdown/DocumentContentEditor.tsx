import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { useLocation } from 'react-router';
import { headingSlug } from '@pm-markdown';
import { EditorSelection, Prec, Transaction } from '@codemirror/state';
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import { isolateHistory, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { foldAll, foldCode, unfoldAll, unfoldCode } from '@codemirror/language';
import { Bold, ChevronDown, Code2, Columns2, Eye, Italic, List, ListTree, MoreHorizontal, Redo2, Search, Undo2 } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '../../../components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../../components/ui/dialog';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuPopup, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger, useContextMenu } from '@/components/ui/context-menu';
import type { WorkspaceController } from './controller';
import type { DocumentCommandDefinition, DocumentEdit } from './document-editing-types';
import { applyDocumentCommand, documentCommands } from './document-commands';
import { applyStructureCommand, documentStructureCommandReasons, scanDocumentBlocks, scanDocumentOutline, structureCommands } from './document-structure';
import { applyBodyChanges, bodyEditorText, bodyOffsetFromEditor, editorOffsetFromBody, splitDocumentBody, type BodyChange } from './document-body';
import { DocumentObjectActions, type DocumentObjectActionsProps } from './DocumentObjectActions';
import { captureDocumentObjectSource } from './document-object-model';
import { Preview } from './Preview';
import { getDocumentEditorPosition, retainDocumentEditorPosition } from './document-workbench-state';
import './document-editor.css';
import { RadixSelect } from "@/components/ui/radix-select"

const commands = [...documentCommands, ...structureCommands];
const structureIds: Record<string, true> = Object.fromEntries(structureCommands.map(command => [command.id, true]));
type Target = { id: string; scope: string; raw: string; revision: string; from: number; to: number; selection?: { from: number; to: number } };
type CommandGroup = { label: string; labelEn: string; commands?: DocumentCommandDefinition[]; children?: CommandGroup[] };
const byIds = (ids: string[]) => commands.filter(command => ids.includes(command.id));
const groups: CommandGroup[] = [
  { label: '文本', labelEn: 'Text', children: [
    { label: '强调与代码', labelEn: 'Emphasis & code', commands: byIds(['bold', 'italic', 'bolditalic', 'strike', 'inline-code', 'underline', 'superscript', 'subscript', 'clear-formatting']) },
    { label: '高亮与样式', labelEn: 'Highlight & style', commands: commands.filter(command => command.id.startsWith('highlight-') || ['color', 'font', 'font-size'].includes(command.id)) },
  ] },
  { label: '段落', labelEn: 'Paragraph', children: [
    { label: '标题与段落', labelEn: 'Headings & paragraph', commands: commands.filter(command => command.id.startsWith('heading-') || command.id === 'paragraph') },
    { label: '列表、引用与缩进', labelEn: 'Lists, quote & indent', commands: byIds(['ordered-list', 'unordered-list', 'task-list', 'blockquote', 'indent', 'outdent']) },
  ] },
  { label: '插入', labelEn: 'Insert', children: [
    { label: '链接与媒体', labelEn: 'Links & media', commands: byIds(['link', 'internal-link', 'image', 'document-embed']) },
    { label: '结构、公式与模板', labelEn: 'Blocks, math & templates', commands: commands.filter(command => command.group === 'insert' && !['link', 'internal-link', 'image', 'document-embed'].includes(command.id) || command.group === 'template') },
  ] },
  { label: '表格', labelEn: 'Table', commands: structureCommands.filter(command => command.group === 'table') },
  { label: '块操作', labelEn: 'Block', commands: structureCommands.filter(command => command.group !== 'table') },
];

function selectDocumentFragment(editor: EditorView, raw: string, hash: string) {
  if (!hash) return;
  let fragment: string;
  try { fragment = decodeURIComponent(hash.slice(1)); } catch { return; }
  const text = splitDocumentBody(raw)?.body;
  if (text === undefined || bodyEditorText(text) !== editor.state.doc.toString()) return;
  const range = fragment.startsWith('^')
    ? scanDocumentBlocks(text).find(block => block.kind !== 'code' && text.slice(block.from, block.to).match(/\^([\w-]+)[ \t]*$/m)?.[1] === fragment.slice(1))
    : scanDocumentOutline(text).find(heading => headingSlug(heading.title) === headingSlug(fragment));
  if (!range) return;
  const position = editorOffsetFromBody(text, range.from);
  editor.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) });
}

export function DocumentContentEditor({ controller: c, en, onSource }: { controller: WorkspaceController; en: boolean; onSource: () => void }) {
  const location = useLocation();
  const view = useRef<EditorView | null>(null);
  const previewPane = useRef<HTMLElement | null>(null);
  const restoreFrame = useRef(0);
  const latest = useRef(c);
  latest.current = c;
  const pendingBody = useRef<string | null>(null);
  const draggedBlock = useRef<{ target: Target; index: number } | null>(null);
  const split = splitDocumentBody(c.raw);
  const body = split?.body ?? '';
  const disabled = !c.canEditSourceDraft || !split;
  const [selection, setSelection] = useState({ from: 0, to: 0 });
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const [layout, setLayout] = useState<'split' | 'edit' | 'preview'>(() => getDocumentEditorPosition(c.session, c.selectedId, 'body')?.layout ?? 'preview');
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [menu, setMenu] = useState<{ target: Target } | null>(null);
  const editorMenu = useContextMenu<Target>();
  const [rangeMenu, setRangeMenu] = useState<Target | null>(null);
  const [objectRequest, setObjectRequest] = useState<DocumentObjectActionsProps['request']>(null);
  const [palette, setPalette] = useState<{ target: Target; query: string; index: number } | null>(null);
  const [input, setInput] = useState<{ target: Target; command: DocumentCommandDefinition; value: string } | null>(null);
  const [error, setError] = useState('');
  const outline = useMemo(() => scanDocumentOutline(body), [body]);
  const blocks = useMemo(() => scanDocumentBlocks(body), [body]);
  const commandReasons = useMemo(() => documentStructureCommandReasons(body, selection), [body, selection]);
  const menuTarget = editorMenu.target ?? menu?.target;
  const menuCommandReasons = useMemo<Record<string, string | null>>(() => menuTarget ? documentStructureCommandReasons(splitDocumentBody(menuTarget.raw)?.body ?? '', menuTarget) : {}, [menuTarget]);
  const rangeCommandReasons = useMemo<Record<string, string | null>>(() => rangeMenu ? documentStructureCommandReasons(splitDocumentBody(rangeMenu.raw)?.body ?? '', rangeMenu) : {}, [rangeMenu]);
  const label = (english: string, zh: string) => en ? english : zh;
  const commandLabel = (command: DocumentCommandDefinition) => en ? command.labelEn : command.label;
  const positionState = useRef({ layout });
  positionState.current.layout = layout;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  function retainPosition() {
    const editor = view.current;
    if (!editor) return;
    const range = editor.state.selection.main;
    retainDocumentEditorPosition(c.session, c.selectedId, 'body', { anchor: range.anchor, head: range.head, scrollTop: editor.scrollDOM.scrollTop, scrollLeft: editor.scrollDOM.scrollLeft, previewScrollTop: previewPane.current?.scrollTop, layout: positionState.current.layout });
  }
  const retainLatestPosition = useRef(retainPosition);
  retainLatestPosition.current = retainPosition;
  useLayoutEffect(() => () => { cancelAnimationFrame(restoreFrame.current); retainLatestPosition.current(); }, []);
  useEffect(() => {
    if (!location.hash) return;
    let positionFrame = 0;
    const revealFrame = requestAnimationFrame(() => {
      if (layoutRef.current === 'preview') {
        positionFrame = requestAnimationFrame(() => {
          let fragment: string;
          try { fragment = decodeURIComponent(location.hash.slice(1)); } catch { return; }
          const slug = headingSlug(fragment);
          const match = Array.from(document.querySelectorAll<HTMLElement>('.document-preview-pane .markdown-preview h1, .document-preview-pane .markdown-preview h2, .document-preview-pane .markdown-preview h3, .document-preview-pane .markdown-preview h4, .document-preview-pane .markdown-preview h5, .document-preview-pane .markdown-preview h6')).find(element => element.id.endsWith(`heading-${slug}`));
          if (match) match.scrollIntoView({ block: 'start' });
          else if (previewPane.current) previewPane.current.scrollTop = 0;
        });
        return;
      }
      positionFrame = requestAnimationFrame(() => {
        const controller = latest.current;
        if (view.current) selectDocumentFragment(view.current, controller.session.drafts.getSnapshot()[controller.selectedId]?.raw ?? controller.selected?.raw ?? '', location.hash);
      });
    });
    return () => { cancelAnimationFrame(revealFrame); cancelAnimationFrame(positionFrame); };
  }, [location.hash, c.selectedId]);

  function target(): Target {
    const controller = latest.current;
    const raw = controller.session.drafts.getSnapshot()[controller.selectedId]?.raw ?? controller.selected?.raw ?? '';
    const currentBody = splitDocumentBody(raw)?.body ?? '';
    const range = view.current?.state.selection.main;
    return { id: controller.selectedId, scope: controller.session.scope, raw, revision: controller.draft?.revision ?? controller.selected?.revision ?? '', from: bodyOffsetFromEditor(currentBody, range?.from ?? 0), to: bodyOffsetFromEditor(currentBody, range?.to ?? 0) };
  }

  function requireTarget(expected: Target, write = true) {
    const current = target();
    const selection = expected.selection ?? expected;
    if (!view.current?.dom.isConnected || current.id !== expected.id || current.scope !== expected.scope || current.raw !== expected.raw || current.revision !== expected.revision || current.from !== selection.from || current.to !== selection.to) throw new Error(label('The document, revision or selection changed. Select the intended text and try again.', '文档、版本或选区已更改，请重新选择目标文字后重试。'));
    if (view.current.composing) throw new Error(label('Finish composing text before applying a command.', '请先完成输入法组字，再执行命令。'));
    if (write && !latest.current.canEditSourceDraft) throw new Error(label('Editing is locked. Resolve the access, revision or pending-write notice first.', '编辑已锁定，请先处理权限、版本冲突或待确认写入。'));
    const parts = splitDocumentBody(current.raw);
    if (!parts) throw new Error(label('The YAML boundary is invalid. Repair the Markdown source.', 'YAML 分隔符无效，请修复 Markdown 源码。'));
    if (bodyEditorText(parts.body) !== view.current.state.doc.toString()) throw new Error(label('The editor is synchronizing a source change. Try again after it updates.', '编辑器正在同步源码更改，请同步完成后重试。'));
    return { editor: view.current, ...parts };
  }

  function apply(edit: DocumentEdit, expected: Target) {
    const { editor, body: originalBody } = requireTarget(expected);
    const original = editor.state.doc.toString();
    const next = bodyEditorText(edit.text);
    let from = 0;
    while (from < original.length && from < next.length && original[from] === next[from]) from++;
    let to = original.length;
    let end = next.length;
    while (to > from && end > from && original[to - 1] === next[end - 1]) { to--; end--; }
    pendingBody.current = edit.text;
    try {
      editor.dispatch({ changes: { from, to, insert: next.slice(from, end) }, selection: EditorSelection.range(editorOffsetFromBody(edit.text, edit.selection.from), editorOffsetFromBody(edit.text, edit.selection.to)), annotations: [Transaction.userEvent.of('input.format'), isolateHistory.of('full')], scrollIntoView: true });
      // A selection-only command does not produce onChange.
      if (originalBody === edit.text) pendingBody.current = null;
      editor.focus();
      setError('');
    } finally { pendingBody.current = null; }
  }

  function run(command: DocumentCommandDefinition, expected = target(), value?: string) {
    try {
      const { body: text } = requireTarget(expected);
      if (command.input && value === undefined) {
        setInput({ target: expected, command, value: command.input.initial ?? '' });
        return;
      }
      let supplied = value;
      if (command.id === 'template' && supplied && !supplied.trim().startsWith('{')) {
        const now = new Date();
        const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        supplied = JSON.stringify({ template: supplied, date, time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` });
      }
      apply((structureIds[command.id] ? applyStructureCommand : applyDocumentCommand)(text, { from: expected.from, to: expected.to }, command.id, supplied), expected);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function openPalette() {
    setPalette({ target: target(), query: '', index: 0 });
    setError('');
  }

  async function clipboard(action: 'copy' | 'cut' | 'paste' | 'plain-paste', expected: Target) {
    try {
      const { body: text } = requireTarget(expected, action !== 'copy');
      if (!navigator.clipboard) throw new Error(label('Clipboard access is unavailable. Use the browser’s native keyboard shortcut in the editor.', '浏览器未提供剪贴板权限，请在编辑器中使用原生键盘快捷键。'));
      if (action === 'copy' || action === 'cut') {
        if (expected.from === expected.to) throw new Error(label('Select text to copy or cut.', '请先选择需要复制或剪切的文字。'));
        await navigator.clipboard.writeText(text.slice(expected.from, expected.to));
        requireTarget(expected, action === 'cut');
        if (action === 'cut') apply({ text: text.slice(0, expected.from) + text.slice(expected.to), selection: { from: expected.from, to: expected.from } }, expected);
      } else {
        // Markdown is authoritative: even regular paste reads text, never HTML.
        const pasted = await navigator.clipboard.readText();
        requireTarget(expected);
        apply({ text: text.slice(0, expected.from) + pasted + text.slice(expected.to), selection: { from: expected.from + pasted.length, to: expected.from + pasted.length } }, expected);
      }
      setError('');
    } catch (cause) { setError(`${label('Clipboard operation failed', '剪贴板操作失败')}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }

  const handlers = useRef({ openPalette, context: (event: MouseEvent, editor: EditorView) => {
    if (!(event.target instanceof Element) || !event.target.closest('.cm-content')) return false;
    event.preventDefault();
    event.stopPropagation();
    const range = editor.state.selection.main;
    const position = event.clientX || event.clientY ? editor.posAtCoords({ x: event.clientX, y: event.clientY }) : null;
    if (position !== null && (position < range.from || position > range.to || range.empty)) editor.dispatch({ selection: { anchor: position } });
    const caret = editor.coordsAtPos(editor.state.selection.main.head);
    const bounds = editor.contentDOM.getBoundingClientRect();
    setMenu(null);
    editorMenu.openAt({ x: event.clientX || caret?.left || bounds.left + 8, y: event.clientY || caret?.bottom || bounds.top + 20 }, target(), editor.contentDOM);
    return true;
  }, keyboardContext: (editor: EditorView) => {
    const caret = editor.coordsAtPos(editor.state.selection.main.head);
    const bounds = editor.contentDOM.getBoundingClientRect();
    setMenu(null);
    editorMenu.openAt({ x: caret?.left ?? bounds.left + 8, y: caret?.bottom ?? bounds.top + 20 }, target(), editor.contentDOM);
    return true;
  } });
  const extensions = useMemo(() => [markdown(), EditorView.lineWrapping, search(), Prec.highest(keymap.of([
    { key: 'Mod-p', run: () => { handlers.current.openPalette(); return true; }, stopPropagation: true },
    { key: 'Shift-F10', run: editor => handlers.current.keyboardContext(editor), stopPropagation: true },
    { key: 'ContextMenu', run: editor => handlers.current.keyboardContext(editor), stopPropagation: true },
    { key: '/', run: editor => {
      if (editor.state.readOnly || editor.composing) return false;
      const range = editor.state.selection.main;
      if (!range.empty || editor.state.sliceDoc(editor.state.doc.lineAt(range.from).from, range.from).trim()) return false;
      handlers.current.openPalette();
      return true;
    } },
    ...searchKeymap,
  ])), EditorView.domEventHandlers({ contextmenu: (event, editor) => handlers.current.context(event, editor) })], []);

  function update(editorUpdate: ViewUpdate) {
    if (!editorUpdate.selectionSet && !editorUpdate.docChanged) return;
    retainPosition();
    const current = target();
    setSelection(previous => previous.from === current.from && previous.to === current.to ? previous : { from: current.from, to: current.to });
    const undoCount = undoDepth(editorUpdate.state);
    const redoCount = redoDepth(editorUpdate.state);
    setHistory(previous => previous.undo === undoCount && previous.redo === redoCount ? previous : { undo: undoCount, redo: redoCount });
  }

  function historyAction(action: typeof undo, expected = target()) {
    try { const { editor } = requireTarget(expected); action(editor); editor.focus(); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function renderGroup(group: CommandGroup, expected: Target, context: boolean) {
    const Sub = context ? ContextMenuSub : DropdownMenuSub;
    const SubTrigger = context ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
    const SubContent = context ? ContextMenuSubContent : DropdownMenuSubContent;
    const Item = context ? ContextMenuItem : DropdownMenuItem;
    return <Sub key={group.labelEn}><SubTrigger>{en ? group.labelEn : group.label}</SubTrigger><SubContent className="document-menu">{group.children?.map(child => renderGroup(child, expected, context))}{group.commands?.map(command => {
      const reason = disabled ? readonlyReason : menuCommandReasons[command.id];
      return <Item key={command.id} disabled={!!reason} title={reason || undefined} aria-label={reason ? `${commandLabel(command)} · ${reason}` : undefined} onSelect={() => run(command, expected)}><span>{commandLabel(command)}{reason && <small className="document-command-reason">{reason}</small>}</span></Item>;
    })}</SubContent></Sub>;
  }

  function openObjectSection(section: 'task' | 'objects' | 'attachments', expected: Target) {
    try {
      const { body: text } = requireTarget(expected, false);
      setObjectRequest({ section, source: captureDocumentObjectSource(expected.id, expected.raw, expected.revision, { from: expected.from, to: expected.to, text: text.slice(expected.from, expected.to) }), token: (objectRequest?.token ?? 0) + 1 });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function renderEditingMenu(expected: Target, context: boolean) {
    const Item = context ? ContextMenuItem : DropdownMenuItem;
    const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
    return <>
      <Item disabled={disabled || !history.undo} onSelect={() => historyAction(undo, expected)}>{label('Undo', '撤销')}</Item>
      <Item disabled={disabled || !history.redo} onSelect={() => historyAction(redo, expected)}>{label('Redo', '重做')}</Item>
      <Separator className="document-menu-separator" />
      {(['cut', 'copy', 'paste', 'plain-paste'] as const).map(action => <Item key={action} disabled={action !== 'copy' && disabled || ['copy', 'cut'].includes(action) && expected.from === expected.to} onSelect={() => void clipboard(action, expected)}>{action === 'cut' ? label('Cut', '剪切') : action === 'copy' ? label('Copy', '复制') : action === 'paste' ? label('Paste Markdown text', '粘贴 Markdown 文本') : label('Paste as plain text', '纯文本粘贴')}</Item>)}
      <Separator className="document-menu-separator" />{groups.map(group => renderGroup(group, expected, context))}
      <Separator className="document-menu-separator" />
      <Item disabled={expected.from === expected.to} title={expected.from === expected.to ? label('Select text or a checklist item first', '请先选择文字或检查项') : undefined} onSelect={() => openObjectSection('task', expected)}>{label('Review and prepare task…', '检查并准备任务…')}</Item>
      <Item onSelect={() => openObjectSection('objects', expected)}>{label('Authorized objects and relations…', '授权对象与关联…')}</Item>
      <Item onSelect={() => openObjectSection('attachments', expected)}>{label('Images and attachments…', '图片与附件…')}</Item>
      <Separator className="document-menu-separator" />
      <Item onSelect={() => { if (view.current) openSearchPanel(view.current); }}>{label('Find / replace', '查找 / 替换')}</Item>
      <Item onSelect={() => setPalette({ target: expected, query: '', index: 0 })}>{label('Search all commands…', '搜索全部命令…')}<kbd>Ctrl/⌘ P</kbd></Item>
    </>;
  }

  function renderRangeMenu(range: { from: number; to: number }, trigger: ReactElement) {
    const expected = rangeMenu?.from === range.from && rangeMenu.to === range.to ? rangeMenu : null;
    return <ContextMenu key={`${range.from}:${range.to}`} onOpenChange={open => {
      if (!open) return;
      const current = target();
      setRangeMenu({ ...current, raw: c.raw, from: range.from, to: range.to, selection: { from: current.from, to: current.to } });
    }}><ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger><ContextMenuContent className="document-menu" aria-label={label('Document structure actions', '文档结构操作')}>
      <ContextMenuItem onSelect={() => {
        if (!expected) return;
        try {
          const { editor, body: text } = requireTarget(expected, false);
          setLayout('edit');
          editor.dispatch({ selection: EditorSelection.range(editorOffsetFromBody(text, expected.from), editorOffsetFromBody(text, expected.to)), scrollIntoView: true });
          requestAnimationFrame(() => editor.focus());
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }}>{label('Reveal source range', '定位源码范围')}</ContextMenuItem>
      <ContextMenuItem onSelect={() => { if (expected) void clipboard('copy', expected); }}>{label('Copy Markdown source', '复制 Markdown 源码')}</ContextMenuItem>
      <ContextMenuSeparator />
      {expected && structureCommands.map(command => {
        const reason = disabled ? readonlyReason : rangeCommandReasons[command.id];
        return <ContextMenuItem key={command.id} disabled={!!reason || !expected} title={reason || undefined} onSelect={() => { if (expected) run(command, expected); }}><span>{commandLabel(command)}{reason && <small className="document-command-reason">{reason}</small>}</span></ContextMenuItem>;
      })}
    </ContextMenuContent></ContextMenu>;
  }

  function dropBlock(destination: number) {
    const dragged = draggedBlock.current;
    draggedBlock.current = null;
    if (!dragged || dragged.index === destination) return;
    try {
      const { body: text } = requireTarget(dragged.target);
      const ranges = scanDocumentBlocks(text);
      const fromIndex = Math.min(dragged.index, destination);
      const toIndex = Math.max(dragged.index, destination);
      const affected = ranges.slice(fromIndex, toIndex + 1);
      if (!ranges[destination] || affected.length !== toIndex - fromIndex + 1) throw new Error(label('The block target changed. Start the drag again.', '内容块目标已更改，请重新拖动。'));
      const contents = affected.map(range => text.slice(range.from, range.to));
      const moved = contents.splice(dragged.index - fromIndex, 1)[0];
      contents.splice(destination - fromIndex, 0, moved);
      let replacement = '';
      let movedFrom = affected[0].from;
      for (let index = 0; index < affected.length; index++) {
        if (index === destination - fromIndex) movedFrom = affected[0].from + replacement.length;
        replacement += contents[index];
        if (index + 1 < affected.length) replacement += text.slice(affected[index].to, affected[index + 1].from);
      }
      apply({ text: text.slice(0, affected[0].from) + replacement + text.slice(affected[affected.length - 1].to), selection: { from: movedFrom, to: movedFrom + moved.length } }, dragged.target);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  const readonlyReason = !split ? label('The YAML boundary is invalid; repair the Markdown source.', 'YAML 分隔符无效，请修复 Markdown 源码。') : c.selected?.entity.archived ? label('Archived document. Editing is locked.', '文档已归档，编辑已锁定。') : c.ahead || c.conflict?.id === c.selectedId ? label('Disk changed. Compare versions before editing; your draft is retained.', '磁盘版本已更改，请先比较版本；当前草稿已保留。') : c.writesBlocked ? label('A write is pending or its result is unknown. Resolve its recovery record first.', '写入待确认或结果未知，请先处理原始恢复记录。') : c.configurationInvalid ? label('Workspace configuration has errors. Repair it before editing.', '工作区配置有错误，请先修复配置。') : c.query.isError || c.accessError ? label('Workspace access or refresh failed. Your draft is retained; editing is locked.', '工作区访问或刷新失败，草稿已保留，编辑暂时锁定。') : c.busy ? label('Saving or updating. Editing will resume when it finishes.', '正在保存或更新，完成后可继续编辑。') : label('You do not have write access. The document remains readable.', '当前没有写入权限，仍可阅读文档。');
  const insertionTarget = { id: c.selectedId, scope: c.session.scope, raw: c.raw, revision: c.draft?.revision ?? c.selected?.revision ?? '', ...selection };
  const filtered = commands.filter(command => `${command.id} ${command.label} ${command.labelEn}`.toLocaleLowerCase().includes(palette?.query.toLocaleLowerCase() ?? ''));
  const block = blocks.find(candidate => selection.from >= candidate.from && selection.from < candidate.to);

  return <div className={`document-content-editor document-layout-${layout}`} data-testid="document-content-editor">
    {layout !== 'preview' && disabled && <p className="document-editor-note" role="status">{readonlyReason}</p>}
    {layout !== 'preview' && !split && <button type="button" className="text-button" onClick={onSource}>{label('Repair Markdown source', '修复 Markdown 源码')}</button>}
    <div className="document-format-toolbar" role="toolbar" aria-label={layout === 'preview' ? label('Document view', '文档视图') : label('Markdown formatting', 'Markdown 格式工具栏')}>
      {layout !== 'preview' && <>
        {([['bold', Bold], ['italic', Italic], ['inline-code', Code2], ['unordered-list', List]] as const).map(([id, Icon]) => {
          const command = commands.find(candidate => candidate.id === id);
          return command && <button type="button" key={id} aria-label={commandLabel(command)} title={disabled ? readonlyReason : commandLabel(command)} disabled={disabled} onPointerDown={event => event.preventDefault()} onClick={() => run(command)}><Icon size={16} /></button>;
        })}
        <DropdownMenu open={!!menu} onOpenChange={open => { if (open) { editorMenu.close(); setMenu({ target: target() }); } else setMenu(null); }}><DropdownMenuTrigger asChild><button type="button" aria-label={label('All formatting and editing commands', '全部格式与编辑命令')} title={label('Formatting menu · also available by right-click', '格式菜单 · 也可右键打开')}><MoreHorizontal size={16} /><ChevronDown size={11} /></button></DropdownMenuTrigger><DropdownMenuContent className="document-menu" align="start" onCloseAutoFocus={event => event.preventDefault()}>
          {menu && renderEditingMenu(menu.target, false)}
        </DropdownMenuContent></DropdownMenu>
        <RadixSelect aria-label={label('Heading or paragraph style', '标题或段落样式')} value="" disabled={disabled} onChange={event => { const command = commands.find(candidate => candidate.id === event.target.value); if (command) run(command); }}><option value="">{label('Paragraph', '段落')}</option>{byIds(['paragraph', 'heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5', 'heading-6', 'blockquote', 'task-list', 'strike', 'link', 'image', 'table', 'highlight-yellow']).map(command => <option key={command.id} value={command.id}>{commandLabel(command)}</option>)}</RadixSelect>
        <span className="document-toolbar-divider" />
        <button type="button" disabled={disabled || !history.undo} aria-label={label('Undo', '撤销')} onPointerDown={event => event.preventDefault()} onClick={() => historyAction(undo)}><Undo2 size={16} /></button>
        <button type="button" disabled={disabled || !history.redo} aria-label={label('Redo', '重做')} onPointerDown={event => event.preventDefault()} onClick={() => historyAction(redo)}><Redo2 size={16} /></button>
        <button type="button" aria-label={label('Find / replace', '查找 / 替换')} onClick={() => { if (view.current) openSearchPanel(view.current); }}><Search size={16} /></button>
        <button type="button" onClick={openPalette} aria-label={label('Search commands', '搜索命令')} title={label('Editor commands · Ctrl/⌘ P · slash at line start', '编辑命令 · Ctrl/⌘ P · 行首输入 /')}>/</button>
      </>}
      <button type="button" aria-label={label('Toggle outline', '切换大纲')} aria-pressed={outlineOpen} onClick={() => setOutlineOpen(open => !open)}><ListTree size={16} /></button>
      <div className="document-layout-controls" role="group" aria-label={label('Editor layout', '编辑器布局')}>{([['preview', Eye, 'Reading', '阅读'], ['edit', Code2, 'Source', '源码'], ['split', Columns2, 'Split', '分栏']] as const).map(([mode, Icon, english, zh]) => <button type="button" key={mode} aria-label={label(english, zh)} aria-pressed={layout === mode} onClick={() => setLayout(mode)}><Icon size={16} /></button>)}</div>
    </div>
    {error && <p className="document-editor-error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label={label('Dismiss editor error', '关闭编辑错误')}>×</button></p>}
    <div className="document-editing-workspace">
      {outlineOpen && <aside className="document-outline" aria-label={layout === 'preview' ? label('Document outline', '文档大纲') : label('Document outline and blocks', '文档大纲与内容块')}>
        <strong>{label('Outline', '大纲')}</strong>
        {layout !== 'preview' && <div className="document-fold-controls">{([[foldAll, 'Fold all', '全部折叠'], [unfoldAll, 'Unfold all', '全部展开'], [foldCode, 'Fold current block', '折叠当前块'], [unfoldCode, 'Unfold current block', '展开当前块']] as const).map(([action, english, zh]) => <button type="button" key={english} onClick={() => { if (view.current) action(view.current); }}>{label(english, zh)}</button>)}</div>}
        {!outline.length && <p>{label('No Markdown headings yet.', '还没有 Markdown 标题。')}</p>}
        {outline.map(heading => renderRangeMenu(heading, <button type="button" style={{ paddingInlineStart: `${8 + (heading.level - 1) * 10}px` }} onClick={() => {
          if (layout === 'preview') {
            const match = Array.from(document.querySelectorAll<HTMLElement>('.document-preview-pane .markdown-preview h1, .document-preview-pane .markdown-preview h2, .document-preview-pane .markdown-preview h3, .document-preview-pane .markdown-preview h4, .document-preview-pane .markdown-preview h5, .document-preview-pane .markdown-preview h6')).find(element => element.textContent?.trim() === heading.title);
            (match || previewPane.current)?.scrollIntoView({ block: 'start' });
            return;
          }
          const editor = view.current;
          if (!editor) return;
          const position = editorOffsetFromBody(body, heading.from);
          editor.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'start' }) });
          editor.focus();
        }}>{heading.title}</button>))}
        {layout !== 'preview' && <>
          <strong>{label('Blocks · drag to reorder', '内容块 · 拖动排序')}</strong>
          <p>{label('Select a block to use the Move up/down buttons, or drag it onto another block.', '选择内容块后可用上移/下移按钮，也可拖到另一个内容块上。')}</p>
          {blocks.map((range, index) => renderRangeMenu(range, <button type="button" draggable={!disabled} aria-label={`${label('Select or drag block', '选择或拖动内容块')} ${index + 1}: ${range.kind}`} onClick={() => {
            const editor = view.current;
            if (!editor) return;
            editor.dispatch({ selection: EditorSelection.range(editorOffsetFromBody(body, range.from), editorOffsetFromBody(body, range.to)), scrollIntoView: true });
            editor.focus();
          }} onDragStart={event => {
            const editor = view.current;
            if (!editor || disabled) { event.preventDefault(); return; }
            editor.dispatch({ selection: EditorSelection.range(editorOffsetFromBody(body, range.from), editorOffsetFromBody(body, range.to)) });
            draggedBlock.current = { target: target(), index };
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-pm-document-block', String(index));
          }} onDragOver={event => { if (!disabled && draggedBlock.current) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }} onDrop={event => { event.preventDefault(); dropBlock(index); }} onDragEnd={() => { draggedBlock.current = null; }}>⠿ {index + 1} · {range.kind}<small>{body.slice(range.from, range.to).replace(/\s+/g, ' ').slice(0, 60)}</small></button>))}
        </>}
      </aside>}
      <section className="document-body-pane" aria-label={label('Editable Markdown body', '可编辑 Markdown 正文')}>
        <CodeMirror value={bodyEditorText(body)} extensions={extensions} minHeight="340px" editable={!disabled} readOnly={disabled} aria-label={label('Document content', '文档内容')} data-testid="document-body-editor" basicSetup={{ lineNumbers: false, foldGutter: true, highlightActiveLine: true, highlightSelectionMatches: true }} onCreateEditor={editor => {
          view.current = editor;
          setHistory({ undo: undoDepth(editor.state), redo: redoDepth(editor.state) });
          const position = getDocumentEditorPosition(c.session, c.selectedId, 'body');
          if (position) editor.dispatch({ selection: { anchor: Math.min(position.anchor, editor.state.doc.length), head: Math.min(position.head, editor.state.doc.length) } });
          editor.scrollDOM.addEventListener('scroll', () => retainLatestPosition.current(), { passive: true });
          restoreFrame.current = requestAnimationFrame(() => {
            if (position) {
              editor.scrollDOM.scrollTop = position.scrollTop; editor.scrollDOM.scrollLeft = position.scrollLeft;
              if (previewPane.current) previewPane.current.scrollTop = position.previewScrollTop ?? 0;
            }
            selectDocumentFragment(editor, latest.current.raw, window.location.hash);
          });
        }} onUpdate={update} onChange={(_value, change) => {
          const controller = latest.current;
          const raw = controller.session.drafts.getSnapshot()[controller.selectedId]?.raw ?? controller.selected?.raw ?? '';
          const parts = splitDocumentBody(raw);
          if (!parts || !controller.canEditSourceDraft) return;
          const changes: BodyChange[] = [];
          change.changes.iterChanges((from, to, _from, _to, insert) => changes.push({ from, to, insert: insert.toString() }));
          controller.updateDraft(parts.prefix + (pendingBody.current ?? applyBodyChanges(parts.body, changes)));
        }} />
      </section>
      <section ref={previewPane} onScroll={retainPosition} className="document-preview-pane" aria-label={label('Live draft preview', '实时草稿预览')}>{layout !== 'preview' && <div className="document-pane-label">{label('Live preview · same unsaved draft', '实时预览 · 同一未保存草稿')}</div>}<Preview raw={c.raw} body={body} viewProps={{ ...c.viewProps, files: c.projected, allFiles: c.projected }} hideTitle disabled={disabled || c.draftParseError} onToggle={line => {
        const expected = target();
        try {
          const { prefix, body: text } = requireTarget(expected);
          const bodyLine = line - (prefix.match(/\n/g)?.length ?? 0) - 1;
          const lines = text.split('\n');
          if (!/^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[[ xX]\]/.test(lines[bodyLine] ?? '')) throw new Error(label('The checklist line moved. Try again in the editor.', '清单行已移动，请在编辑器中重试。'));
          lines[bodyLine] = lines[bodyLine].replace(/\[([ xX])\]/, (_, checked: string) => checked === ' ' ? '[x]' : '[ ]');
          apply({ text: lines.join('\n'), selection: { from: expected.from, to: expected.to } }, expected);
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }} onLink={c.wikiLink} /></section>
    </div>
    {layout !== 'preview' && block && <div className="document-block-controls" role="group" aria-label={label('Current block actions', '当前块操作')}><span>{`${label('Block', '块')} · ${block.kind}`}</span>{byIds(['block-move-up', 'block-move-down', 'block-duplicate', 'block-delete']).map(command => <button type="button" key={command.id} disabled={disabled || !!commandReasons[command.id]} title={disabled ? readonlyReason : commandReasons[command.id] || undefined} onPointerDown={event => event.preventDefault()} onClick={() => run(command)}>{commandLabel(command)}</button>)}</div>}
    {layout !== 'preview' && <DocumentObjectActions controller={c} en={en} request={objectRequest} selection={{ ...selection, text: body.slice(selection.from, selection.to) }} disabled={disabled || c.draftInvalid} onInsert={markdownText => {
      const { body: text } = requireTarget(insertionTarget);
      apply({ text: text.slice(0, insertionTarget.from) + markdownText + text.slice(insertionTarget.to), selection: { from: insertionTarget.from + markdownText.length, to: insertionTarget.from + markdownText.length } }, insertionTarget);
    }} />}
    <ContextMenuPopup menu={editorMenu} className="document-menu">{editorMenu.target && renderEditingMenu(editorMenu.target, true)}</ContextMenuPopup>
    {layout !== 'preview' && <p className="document-editor-hint">{label('Markdown is the source of truth, including the H1 title. Real-time saving is on: edits save automatically after they settle, and Save or Ctrl/⌘ S writes immediately. At line start, / opens commands.', 'Markdown（含 H1 标题）是唯一正文来源。实时保存已开启：停止输入后自动写入，也可点击保存或 Ctrl/⌘ S 立即写入。行首输入 / 打开命令。')}</p>}
    <Dialog open={!!palette} onOpenChange={open => { if (!open) setPalette(null); }}><DialogContent className="document-command-dialog" finalFocus={() => view.current?.contentDOM ?? null}><DialogTitle>{label('Editor commands', '编辑器命令')}</DialogTitle><DialogDescription>{label('Search all formatting, insertion and structural commands. Applies to the selection you opened this menu with.', '搜索全部格式、插入和结构命令，操作打开菜单时的选区。')}</DialogDescription><input autoFocus aria-label={label('Search editor commands', '搜索编辑器命令')} value={palette?.query ?? ''} onChange={event => setPalette(current => current && { ...current, query: event.target.value, index: 0 })} onKeyDown={event => {
      if (!palette || !filtered.length) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setPalette({ ...palette, index: (palette.index + (event.key === 'ArrowDown' ? 1 : filtered.length - 1)) % filtered.length }); }
      if (event.key === 'Enter') { event.preventDefault(); const command = filtered[palette.index]; const reason = disabled ? readonlyReason : command && commandReasons[command.id]; if (reason) { setError(reason); return; } setPalette(null); if (command) run(command, palette.target); }
    }} /><div className="document-command-results">{filtered.map((command, index) => {
      const reason = disabled ? readonlyReason : commandReasons[command.id];
      return <button type="button" key={command.id} className={index === palette?.index ? 'is-highlighted' : ''} disabled={!!reason} title={reason || undefined} onClick={() => { const expected = palette?.target; setPalette(null); if (expected) run(command, expected); }}><span>{commandLabel(command)}</span><small>{reason || command.group}</small></button>;
    })}{!filtered.length && <p>{label('No commands match.', '没有匹配的命令。')}</p>}</div></DialogContent></Dialog>
    <Dialog open={!!input} onOpenChange={open => { if (!open) setInput(null); }}><DialogContent className="document-command-dialog" finalFocus={() => view.current?.contentDOM ?? null}><DialogTitle>{input ? commandLabel(input.command) : label('Command options', '命令选项')}</DialogTitle><DialogDescription>{input?.command.input && (en ? input.command.input.labelEn : input.command.input.label)}</DialogDescription><form onSubmit={event => { event.preventDefault(); if (!input) return; const current = input; setInput(null); run(current.command, current.target, current.value); }}><textarea autoFocus aria-label={input?.command.input ? en ? input.command.input.labelEn : input.command.input.label : label('Command value', '命令参数')} rows={input?.command.id === 'template' ? 8 : 3} value={input?.value ?? ''} onChange={event => setInput(current => current && { ...current, value: event.target.value })} /><button type="submit" className="primary-button" disabled={disabled}>{label('Apply to selection', '应用到选区')}</button></form></DialogContent></Dialog>
  </div>;
}
