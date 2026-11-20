import { useAui, useAuiState, type QuoteInfo } from "@assistant-ui/react";
import {
  EditorContent, Mark, Node, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer,
  useEditor, useEditorState, type Editor, type NodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type AriaAttributes, type MutableRefObject } from "react";
import { CheckSquareIcon, FileIcon, LinkIcon, MessageCircleIcon, QuoteIcon, XIcon } from "lucide-react";
import { useAgentText } from "../i18n";
import {
  composerDocumentCursor, composerInlineSource, composerPasteSlice, composerSourceCursor, normalizeComposerReferences,
  parseComposerDocument, readComposerCitation, readComposerContexts, referenceLabel, serializeComposerDocument, type ComposerContextPayload,
} from "./rich-composer-document";
import "./rich-composer.css";
import { useMessageContextDraft } from "./message-context";
import { MessageContextChip } from "./context-presentation";
import { ContextChip, ContextChipAction, ContextChipLabel } from "./context-chip";
import { getEditedContextReferences, getMessageContextItems, setEditedContextReferences, setMessageContextBlocker, subscribeMessageContext } from "./message-context-store";
import { PmContextChip } from "../pm/pm-reference-tray";
import { PM_REFERENCE_LIMIT, usePmIssueWorkspace } from "../pm/pm-issue-workspace";
import { chatContextInputSchema } from "@agent-workspace/contracts/message-context";
import { pmReferenceInputSchema } from "@agent-workspace/contracts/pm-references";
import type { PmReference } from "../pm/pm-types";
import { clipboardAttachmentSchema, prepareComposerContextAttachment, readPreparedComposerAttachment } from "./composer-context-attachments";
import { ComposerAttachmentStrip } from "./composer-attachment-strip";
import { COMPOSER_PROMPT_LIMIT, composerPromptTooLong } from "./composer-limit";
import { SkillContextIcon } from "./context-chip-parts";
import { MESSAGE_CONTEXT_CLIPBOARD_TYPE as CONTEXT_CLIPBOARD_TYPE, contextClipboardPlainText } from "./message-context-clipboard";
import { useChatBrowserPreferences } from "../settings/browser-preferences";
import { isApplePlatform, matchComposerAction, resolveComposerKeymap } from "./composer-shortcuts";
import { resolveBlockDirections } from "./composer-text-direction";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { COMPOSER_EDITABLE_SELECTOR, COMPOSER_FLOATING_LAYER_SELECTOR, COMPOSER_INTERACTIVE_SELECTOR, shouldFocusComposerForPaste } from "./composer-paste-focus";
import { COMPOSER_CONTEXT_DRAG_TYPE } from "./composer-context-drag";


function ContextView({ node, updateAttributes, deleteNode }: NodeViewProps) {
  const t = useAgentText();
  const draft = useMessageContextDraft();
  const payload = node.attrs.payload as ComposerContextPayload | undefined;
  const input = payload?.type === "native" ? payload.item.input : undefined;
  const preview = input ? ("selectedText" in input ? String(input.selectedText ?? "") : "text" in input ? String(input.text ?? "") : "") : "";
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentError, setCommentError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const comment = useRef<HTMLTextAreaElement>(null);
  return <NodeViewWrapper as="span" className="rich-composer-context inline-flex max-w-full items-center gap-0.5" contentEditable={false}>
    {payload?.type === "native" ? <MessageContextChip item={payload.item} /> : payload?.type === "pm" ? <PmContextChip reference={payload.reference} /> : payload?.type === "attachment" ? <span data-composer-attachment-anchor="" /> : <span role="status">Context unavailable</span>}
    {payload?.type === "native" && input && draft.available && input.kind !== "response" && <Popover open={commentOpen} onOpenChange={setCommentOpen}>
      <PopoverTrigger render={<ContextChipAction aria-label={input.comment ? t("编辑引文评论", "Edit citation comment") : t("添加引文评论", "Add citation comment")} title={input.comment || undefined}><MessageCircleIcon /></ContextChipAction>} />
      <PopoverContent side="top" className="w-[min(30rem,90vw)] space-y-2">
        <PopoverTitle className="text-sm font-medium">{t("这条上下文的评论", "Comment on this context")}</PopoverTitle>
        <p className="max-h-24 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground" dir="auto">{preview}</p>
        <textarea key={input.comment} ref={comment} defaultValue={input.comment || ""} maxLength={4000} rows={3} dir="auto" className="w-full rounded-md border bg-background p-2 text-sm" aria-label={t("引文评论", "Citation comment")} />
        <div className="flex items-center gap-3">
          <button type="button" disabled={saving} className="text-sm underline" onClick={() => {
            if (!comment.current) return;
            const value = comment.current.value.slice(0, 4000);
            setSaving(true);
            setCommentError(undefined);
            void draft.add({ ...input, comment: value }).then(() => {
              updateAttributes({ payload: { ...payload, item: { ...payload.item, input: { ...input, comment: value } } } });
              setCommentOpen(false);
            }).catch(cause => setCommentError(cause instanceof Error ? cause.message : String(cause))).finally(() => setSaving(false));
          }}>{t("保存评论", "Save comment")}</button>
          <span className="text-xs text-muted-foreground">{t("评论随这条上下文一起发送。", "The comment is sent with this context.")}</span>
        </div>
        {commentError && <p role="alert" className="text-xs text-destructive">{commentError}</p>}
      </PopoverContent>
    </Popover>}
    {payload?.type !== "attachment" && <ContextChipAction aria-label="Remove context" onClick={deleteNode}><XIcon /></ContextChipAction>}
  </NodeViewWrapper>;
}
const ComposerContext = Node.create({
  name: "composerContext", group: "inline", inline: true, atom: true, selectable: true,
  addAttributes: () => ({ payload: { default: null } }),
  renderHTML: () => ["span", { "data-composer-context": "true" }],
  renderText: () => "",
  addNodeView: () => ReactNodeViewRenderer(ContextView),
});

export type RichComposerHandle = {
  focus: () => void;
  setSelectionRange: (start: number, end: number) => void;
};

export type RichComposerSuggestions = {
  inputRef: MutableRefObject<RichComposerHandle | null>;
  onInput: (cursor: number, inCode?: boolean) => void;
  onKeyDown: (event: KeyboardEvent) => boolean;
  onCompositionStart: () => void;
  onCompositionEnd: (cursor: number, inCode?: boolean) => void;
  inputAria: AriaAttributes;
};

type Props = {
  placeholder: string;
  label: string;
  submitMode: "enter" | "ctrlEnter";
  disabled?: boolean;
  suggestions?: RichComposerSuggestions;
  beforeSend?: () => boolean;
  editing?: boolean;
  /** Wired by the thread shell; Shift+Tab falls back to a window event when absent. */
  interactionMode?: "default" | "plan";
  onInteractionModeChange?: (mode: "default" | "plan") => void | Promise<void>;
};

function ReferenceView({ node, deleteNode }: NodeViewProps) {
  const t = useAgentText();
  const kind = String(node.attrs.kind);
  const value = String(node.attrs.value);
  const label = referenceLabel(kind, value);
  const Icon = kind === "skill" ? SkillContextIcon : FileIcon;
  return <NodeViewWrapper as="span" className="inline-flex max-w-full items-center gap-0.5" contentEditable={false} title={value}>
    <ContextChip kind={kind === "skill" ? "skill" : "file"}><Icon aria-hidden="true" /><ContextChipLabel>{label}</ContextChipLabel></ContextChip>
    <ContextChipAction aria-label={t(`移除引用 ${label}`, `Remove reference ${label}`)} onClick={deleteNode}><XIcon aria-hidden="true" /></ContextChipAction>
  </NodeViewWrapper>;
}

const ComposerReference = Node.create({
  name: "composerReference", group: "inline", inline: true, atom: true, selectable: true,
  addAttributes: () => ({ kind: { default: "file" }, value: { default: "" }, source: { default: "" } }),
  renderHTML: ({ node }) => ["span", { "data-composer-reference": "true" }, String(node.attrs.source)],
  renderText: ({ node }) => String(node.attrs.source),
  addNodeView: () => ReactNodeViewRenderer(ReferenceView),
});

function CitationView({ node, deleteNode }: NodeViewProps) {
  const t = useAgentText();
  const label = (node.attrs.quote as QuoteInfo | undefined)?.text ?? "";
  return <NodeViewWrapper as="span" className="inline-flex max-w-full items-center gap-0.5" contentEditable={false} title={label}>
    <ContextChip kind="citation"><QuoteIcon aria-hidden="true" /><ContextChipLabel>{label}</ContextChipLabel></ContextChip>
    <ContextChipAction aria-label={t("移除选中文字引用", "Remove selected-text citation")} onClick={deleteNode}><XIcon aria-hidden="true" /></ContextChipAction>
  </NodeViewWrapper>;
}

const ComposerCitation = Node.create({
  name: "composerCitation", group: "inline", inline: true, atom: true, selectable: true,
  addAttributes: () => ({ quote: { default: null } }),
  renderHTML: () => ["span", { "data-composer-citation": "true" }],
  renderText: () => "",
  addNodeView: () => ReactNodeViewRenderer(CitationView),
});

function TaskItemView({ node, updateAttributes }: NodeViewProps) {
  const t = useAgentText();
  const checked = node.attrs.checked === true;
  return <NodeViewWrapper as="li" className="rich-composer-task-item" data-checked={checked ? "true" : undefined}>
    <span className="rich-composer-task-check" contentEditable={false}>
      <input type="checkbox" checked={checked} aria-label={t("标记任务完成", "Mark task complete")}
        onChange={(event) => updateAttributes({ checked: event.currentTarget.checked })} />
    </span>
    <div className="rich-composer-task-content"><NodeViewContent /></div>
  </NodeViewWrapper>;
}

const ComposerTaskList = Node.create({
  name: "taskList", group: "block", content: "taskItem+", defining: true,
  parseHTML: () => [{ tag: "ul[data-type='taskList']" }],
  renderHTML: () => ["ul", { "data-type": "taskList", class: "rich-composer-task-list" }, 0],
});

const ComposerTaskItem = Node.create({
  name: "taskItem", content: "paragraph block*", defining: true,
  // `space` keeps an empty checked line byte-identical when the draft is re-read.
  addAttributes: () => ({ checked: { default: false }, space: { default: "" } }),
  parseHTML: () => [{ tag: "li[data-type='taskItem']" }],
  renderHTML: () => ["li", { "data-type": "taskItem" }, 0],
  addNodeView: () => ReactNodeViewRenderer(TaskItemView),
});

/** Links stay Markdown; only absolute destinations are parsed into the mark. */
const ComposerLink = Mark.create({
  name: "link", inclusive: false, exitable: true,
  addAttributes: () => ({ href: { default: null }, title: { default: null } }),
  parseHTML: () => [{ tag: "a[href]" }],
  renderHTML: ({ HTMLAttributes }) => ["a", { ...HTMLAttributes, target: "_blank", rel: "noopener noreferrer nofollow" }, 0],
});

/** Each top-level block carries its own base direction; the draft text never changes. */
function applyComposerDirections(dom: HTMLElement): void {
  const blocks = [...dom.children].map(element => {
    const host = element as HTMLElement;
    if (element.tagName === "PRE") return { element, text: "", code: true };
    // Inline code is masked, not removed from the draft: a Latin identifier must
    // not flip an Arabic line, and code itself renders left to right.
    const copy = host.cloneNode(true) as HTMLElement;
    for (const code of copy.querySelectorAll("code")) code.replaceWith(" ");
    return { element, text: copy.textContent ?? "", code: false };
  });
  const directions = resolveBlockDirections(blocks);
  blocks.forEach((block, index) => {
    const direction = directions[index];
    if (direction && block.element.getAttribute("dir") !== direction) block.element.setAttribute("dir", direction);
    else if (!direction && block.element.hasAttribute("dir")) block.element.removeAttribute("dir");
  });
}

function composerExtensions() {
  return [
    StarterKit.configure({
      codeBlock: false,
      dropcursor: false, link: false,
      paragraph: false, trailingNode: false, underline: false,
    }),
    Node.create({
      name: "paragraph", group: "block", content: "inline*", priority: 1000,
      addAttributes: () => ({ citationOnly: { default: false } }),
      parseHTML: () => [{ tag: "p" }],
      renderHTML: () => ["p", 0],
    }),
    Node.create({
      name: "codeBlock", group: "block", content: "text*", marks: "", code: true, defining: true,
      addAttributes: () => ({ language: { default: "" }, fence: { default: "```" }, originalOpening: { default: null },
        originalLanguage: { default: null }, closing: { default: "```" }, hasBodyLine: { default: true } }),
      parseHTML: () => [{ tag: "pre", preserveWhitespace: "full" }],
      renderHTML: () => ["pre", ["code", 0]],
      addKeyboardShortcuts() {
        return {
          Tab: () => this.editor.isActive("codeBlock") && this.editor.commands.insertContent("  "),
          "Mod-Enter": () => {
            if (!this.editor.isActive("codeBlock")) return false;
            const end = this.editor.state.selection.$to.end();
            return this.editor.chain().insertContentAt(end + 1, { type: "paragraph" }).setTextSelection(end + 2).run();
          },
        };
      },
    }),
    ComposerReference, ComposerCitation, ComposerContext, ComposerTaskList, ComposerTaskItem, ComposerLink,
  ];
}

/** A thread-keyed editor never carries selection/undo state into a different session. */
export function RichComposerInput(props: Props) {
  const localId = useAuiState((state) => state.threads.mainThreadId);
  return <RichComposerEditor key={`${localId}:${props.editing ? "edit" : "thread"}`} {...props} />;
}

function RichComposerEditor(props: Props) {
  const t = useAgentText();
  const aui = useAui();
  const text = useAuiState((state) => state.composer.text);
  const quote = useAuiState((state) => state.composer.quote);
  const contextDraft = useMessageContextDraft();
  const workspace = usePmIssueWorkspace();
  const editedSnapshot = useCallback(() => getEditedContextReferences(contextDraft.targetKey), [contextDraft.targetKey]);
  const editedReferences = useSyncExternalStore(subscribeMessageContext, editedSnapshot, editedSnapshot);
  const references = props.editing ? editedReferences : workspace.references;
  const attachments = useAuiState(value => value.composer.attachments);
  const threadMessages = useAuiState(value => value.thread.messages);
  const promptHistory = useMemo(() => threadMessages.flatMap(message => message.role === "user"
    ? [message.content.filter(part => part.type === "text").map(part => part.text).join("\n")].filter(text => text.trim())
    : []), [threadMessages]);
  const historyIndex = useRef(-1);
  const historyDraft = useRef("");
  const contextPayloads = useMemo<ComposerContextPayload[]>(() => [...contextDraft.items.map(item => ({ type: "native" as const, item })), ...references.map(reference => ({ type: "pm" as const, reference })), ...attachments.map(attachment => ({ type: "attachment" as const, attachment }))], [contextDraft.items, references, attachments]);
  const contextLive = useRef({ draft: contextDraft, workspace, payloads: contextPayloads, references, editing: props.editing });
  contextLive.current = { draft: contextDraft, workspace, payloads: contextPayloads, references, editing: props.editing };
  const syncingContexts = useRef(false);
  const restoringAttachments = useRef(new Set<string>());
  useEffect(() => {
    const draft = contextLive.current.draft;
    for (const attachment of attachments) void prepareComposerContextAttachment(draft.targetKey, attachment).catch(cause => {
      if (draft.isCurrent()) setMessageContextBlocker(draft.targetKey, `attachment:${attachment.id}`, String(cause));
    });
  }, [attachments, contextDraft.targetKey]);
  const [contextError, setContextError] = useState<string>();
  const quoteAttempt = useRef<string | undefined>(undefined);
  const remoteId = useAuiState(value => value.threadListItem.remoteId);
  useEffect(() => {
    if (!quote) { quoteAttempt.current = undefined; return; }
    const key = JSON.stringify([quote.messageId, quote.text]);
    if (quoteAttempt.current === key) return;
    quoteAttempt.current = key;
    const draft = contextLive.current.draft;
    let cancelled = false;
    void (async () => {
      if (!remoteId) throw new Error("The quote source session is unavailable.");
      const resolved = await draft.resolveInputs([{ contextId: crypto.randomUUID(), kind: "response", source: { type: "response", threadId: remoteId, messageId: quote.messageId }, selectedText: quote.text }]);
      if (cancelled || !draft.isCurrent()) return;
      const current = aui.composer.getState().quote;
      if (current?.messageId !== quote.messageId || current?.text !== quote.text) return;
      draft.replaceItems([...getMessageContextItems(draft.targetKey), ...resolved]);
      aui.composer.setQuote(undefined);
      setContextError(undefined);
    })().catch(cause => { if (!cancelled && draft.isCurrent()) setContextError(`The selected text could not be verified. Remove or reselect the quote before sending. ${String(cause)}`); });
    return () => { cancelled = true; };
  }, [aui, quote, remoteId]);
  const { preferences } = useChatBrowserPreferences();
  const keymap = useMemo(() => resolveComposerKeymap(preferences.composerKeymap, props.submitMode), [preferences.composerKeymap, props.submitMode]);
  const apple = useMemo(() => isApplePlatform(), []);
  const [planNotice, setPlanNotice] = useState<string>();
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [linkError, setLinkError] = useState<string>();
  const linkRange = useRef<{ from: number; to: number } | undefined>(undefined);
  const [dragActive, setDragActive] = useState(false);
  const linkButton = useRef<HTMLButtonElement>(null);

  function togglePlanMode() {
    const current = live.current.props;
    const next: "default" | "plan" = current.interactionMode === "plan" ? "default" : "plan";
    if (current.onInteractionModeChange) {
      setPlanNotice(undefined);
      void Promise.resolve(current.onInteractionModeChange(next)).catch(cause => setPlanNotice(cause instanceof Error ? cause.message : String(cause)));
      return;
    }
    // A host without the callback can claim this cancellable event and persist the mode itself.
    const handled = !window.dispatchEvent(new CustomEvent("pm:composer-plan-toggle", { detail: { mode: next }, cancelable: true }));
    setPlanNotice(handled ? undefined : t("此页面未连接会话的 Plan 模式切换；未更改任何会话参数。", "Plan mode switching is not connected in this view; no session setting changed."));
  }

  /** Paste and drop share one importer so both validate and resolve context identically. */
  function importStructuredContext(view: Editor["view"], structured: string, plainText: string): void {
    try {
      const data = JSON.parse(structured) as { version?: unknown; contexts?: unknown; quote?: unknown; quoteThreadId?: unknown; text?: unknown };
      if (data.version !== 1 || !Array.isArray(data.contexts)) throw new Error("Unsupported context clipboard record.");
      const inputs = data.contexts.filter(value => value?.type === "native").map(value => chatContextInputSchema.parse(value.item?.input));
      const pm: PmReference[] = data.contexts.filter(value => value?.type === "pm").map(value => {
        const reference = value.reference as PmReference;
        const parsed = pmReferenceInputSchema.parse({ workspaceId: reference.workspaceId, projectId: reference.projectId, kind: reference.kind, id: reference.id, revision: reference.revision });
        return { ...parsed, title: typeof reference.title === "string" ? reference.title : parsed.id, availability: "unverified" };
      });
      const pastedAttachments = data.contexts.filter(value => value?.type === "attachment").map(value => clipboardAttachmentSchema.parse(value.attachment));
      if (data.contexts.length !== inputs.length + pm.length + pastedAttachments.length || contextLive.current.draft.items.length + inputs.length > 20 || contextLive.current.references.length + pm.length > PM_REFERENCE_LIMIT) throw new Error("The pasted or dropped context exceeds the current limit or contains an unknown record.");
      if (pastedAttachments.length && !aui.thread.getState().capabilities.attachments) throw new Error("Attachments are unavailable in this session.");
      const existingAttachmentIds = new Set(aui.composer.getState().attachments.map(attachment => attachment.id));
      if (new Set(pastedAttachments.map(attachment => attachment.id)).size !== pastedAttachments.length || pastedAttachments.some(attachment => existingAttachmentIds.has(attachment.id))) throw new Error("An attachment with this identity is already in the draft.");
      const pastedQuote = data.quote;
      if (pastedQuote !== undefined && (!pastedQuote || typeof pastedQuote !== "object" || !("text" in pastedQuote) || typeof pastedQuote.text !== "string" || !("messageId" in pastedQuote) || typeof pastedQuote.messageId !== "string")) throw new Error("Invalid quote clipboard record.");
      if (pastedQuote) {
        if (typeof data.quoteThreadId !== "string") throw new Error("The copied quote has no source session identity.");
        const quote = pastedQuote as QuoteInfo;
        inputs.push(chatContextInputSchema.parse({ contextId: crypto.randomUUID(), kind: "response", source: { type: "response", threadId: data.quoteThreadId, messageId: quote.messageId }, selectedText: quote.text }));
        if (contextLive.current.draft.items.length + inputs.length > 20) throw new Error("The copied quote exceeds the context limit.");
      }
      const source = typeof data.text === "string" ? data.text : plainText;
      const current = contextLive.current;
      const originalDoc = view.state.doc;
      const ids = new Set(current.draft.items.map(item => item.input.contextId));
      if (inputs.some(input => ids.has(input.contextId))) throw new Error("This context is already selected. Remove it before pasting or dropping another copy.");
      const pmKeys = new Set(current.references.map(reference => JSON.stringify([reference.workspaceId, reference.projectId, reference.kind, reference.id])));
      const newPm = pm.filter(reference => !pmKeys.has(JSON.stringify([reference.workspaceId, reference.projectId, reference.kind, reference.id])));
      setContextError("Checking dropped context; the draft has not changed.");
      void current.draft.resolveInputs(inputs).then(resolved => {
        if (!current.draft.isCurrent() || view.isDestroyed) return;
        if (view.state.doc !== originalDoc) throw new Error("The draft changed during context resolution. Paste or drop again; nothing was replaced.");
        const payloads: ComposerContextPayload[] = [...resolved.map(item => ({ type: "native" as const, item })), ...newPm.map(reference => ({ type: "pm" as const, reference })), ...pastedAttachments.map(attachment => ({ type: "attachment" as const, attachment: { ...attachment, status: { type: "complete" as const } } }))];
        const doc = view.state.schema.nodeFromJSON(parseComposerDocument(source, undefined, payloads));
        const from = doc.firstChild?.type.name === "paragraph" ? 1 : 0;
        const to = doc.content.size - (doc.lastChild?.type.name === "paragraph" ? 1 : 0);
        view.dispatch(view.state.tr.replaceSelection(doc.slice(from, to)).scrollIntoView());
        setContextError(undefined);
      }).catch(cause => { if (current.draft.isCurrent()) setContextError(String(cause)); });
    } catch (cause) { setContextError(cause instanceof Error ? cause.message : String(cause)); }
  }

  const runtimeDisabled = useAuiState((state) => state.thread.isLoading || state.thread.isDisabled || state.composer.dictation?.inputDisabled);
  const disabled = props.disabled || !!runtimeDisabled;
  const live = useRef({ props, disabled, keymap, isApple: apple });
  live.current = { props, disabled, keymap, isApple: apple };
  const lastText = useRef(text);
  // The keydown handler is created with the editor's first options, before `editor` exists.
  const editorRef = useRef<Editor | null>(null);
  const composing = useRef(false);
  const compositionEnded = useRef(0);
  const normalizing = useRef(false);
  const frame = useRef<number | undefined>(undefined);
  const editor = useEditor({
    extensions: composerExtensions(),
    content: parseComposerDocument(text, quote, contextPayloads),
    editable: !disabled,
    immediatelyRender: false,
    editorProps: {
      attributes: { role: props.suggestions ? "combobox" : "textbox", "aria-multiline": "true", "aria-label": props.label,
        "data-placeholder": props.placeholder, class: "aui-composer-input rich-composer-editor", spellcheck: "true" },
      handleKeyDown: (view, event) => {
        if (live.current.disabled) return false;
        if (composing.current || view.composing || event.isComposing || event.keyCode === 229) return false;
        if (view.state.selection.$from.parent.type.name !== "codeBlock" && live.current.props.suggestions?.onKeyDown(event)) return true;
        // Recall sent prompts only at the first/last line, keeping normal cursor
        // movement and menu navigation untouched.
        if (!live.current.props.editing && (event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
          const selection = view.state.selection;
          const atStart = selection.empty && selection.from <= 1;
          const atEnd = selection.empty && selection.to >= view.state.doc.content.size - 1;
          if (event.key === "ArrowUp" && atStart && promptHistory.length) {
            event.preventDefault();
            if (historyIndex.current < 0) { historyDraft.current = aui.composer.getState().text; historyIndex.current = promptHistory.length - 1; }
            else historyIndex.current = Math.max(0, historyIndex.current - 1);
            aui.composer.setText(promptHistory[historyIndex.current]!);
            requestAnimationFrame(() => editor?.commands.focus("end"));
            return true;
          }
          if (event.key === "ArrowDown" && atEnd && historyIndex.current >= 0) {
            event.preventDefault();
            if (historyIndex.current < promptHistory.length - 1) {
              historyIndex.current += 1;
              aui.composer.setText(promptHistory[historyIndex.current]!);
            } else {
              historyIndex.current = -1;
              aui.composer.setText(historyDraft.current);
            }
            requestAnimationFrame(() => editor?.commands.focus("end"));
            return true;
          }
        }
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") historyIndex.current = -1;
        if (event.key === "Escape" && live.current.props.editing && aui.composer.getState().canCancel) {
          event.preventDefault();
          aui.composer.cancel();
          requestAnimationFrame(() => document.querySelector<HTMLElement>(".aui-composer-root [contenteditable='true']")?.focus());
          return true;
        }
        const action = matchComposerAction(live.current.keymap, event, live.current.isApple);
        if (action === "togglePlan") {
          event.preventDefault();
          togglePlanMode();
          return true;
        }
        // Browsers may emit one final non-composing Enter for the same IME commit.
        if (event.key === "Enter" && Date.now() - compositionEnded.current < 80) { event.preventDefault(); return true; }
        const inCode = view.state.selection.$from.parent.type.name === "codeBlock";
        if (inCode || !action) return false;
        const thread = aui.thread.getState();
        if (action === "steer") {
          if (!thread.capabilities.queue || !aui.composer.getState().canSend) return false;
          event.preventDefault();
          if (!composerPromptTooLong(aui.composer.getState().text) && !live.current.props.beforeSend?.()) aui.composer.send({ steer: true });
          return true;
        }
        const $from = view.state.selection.$from;
        const enclosing = $from.node($from.depth - 1)?.type.name;
        const inList = enclosing === "listItem" || enclosing === "taskItem";
        const inQuote = !inList && enclosing === "blockquote";
        const inHeading = $from.parent.type.name === "heading";
        const plainEnter = event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
        const shiftEnter = event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
        if (action === "newline") {
          // The editor's own defaults already insert these two breaks.
          if (plainEnter || shiftEnter) return false;
          event.preventDefault();
          view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodes.hardBreak!.create()));
          return true;
        }
        // Inside a list, quote or heading, plain Enter continues the block;
        // the same action with a modifier still sends.
        if ((inList || inQuote || inHeading) && plainEnter) {
          if (enclosing === "taskItem" && editorRef.current?.commands.splitListItem("taskItem")) { event.preventDefault(); return true; }
          return false;
        }
        if (thread.isRunning && !thread.capabilities.queue && thread.voice === undefined) return false;
        event.preventDefault();
        view.dom.closest("form")?.requestSubmit();
        return true;
      },
      handleDOMEvents: {
        copy: (view, event) => {
          const selected = view.state.doc.slice(view.state.selection.from, view.state.selection.to);
          const contexts: ComposerContextPayload[] = [];
          selected.content.descendants(node => { if (node.type.name === "composerContext") contexts.push(node.attrs.payload as ComposerContextPayload); });
          const selectedDoc = view.state.schema.topNodeType.create(null, selected.content);
          const quote = readComposerCitation(selectedDoc);
          if (!contexts.length && !quote) return false;
          let plain = "";
          if (selected.content.firstChild?.isInline) selected.content.forEach(node => { plain += composerInlineSource(node); });
          else plain = serializeComposerDocument(selectedDoc);
          try {
            const records = contexts.map(payload => payload.type === "attachment" ? { type: "attachment" as const, attachment: readPreparedComposerAttachment(contextLive.current.draft.targetKey, payload.attachment.id) } : payload.type === "native" ? { type: "native" as const, item: { input: payload.item.input } } : payload);
            event.clipboardData?.setData(CONTEXT_CLIPBOARD_TYPE, JSON.stringify({ version: 1, text: plain, contexts: records, quote, quoteThreadId: remoteId }));
            event.clipboardData?.setData("text/plain", contextClipboardPlainText([plain, quote ? `[Quoted response ${quote.messageId}]\n${quote.text}` : ""].filter(Boolean).join("\n\n"), records));
          } catch (cause) { event.preventDefault(); setContextError(String(cause)); return true; }
          event.preventDefault(); return true;
        },
        cut: (view, event) => {
          if (live.current.disabled) return false;
          const selected = view.state.doc.slice(view.state.selection.from, view.state.selection.to);
          const contexts: ComposerContextPayload[] = [];
          selected.content.descendants(node => { if (node.type.name === "composerContext") contexts.push(node.attrs.payload as ComposerContextPayload); });
          const selectedDoc = view.state.schema.topNodeType.create(null, selected.content);
          const quote = readComposerCitation(selectedDoc);
          if (!contexts.length && !quote) return false;
          let plain = "";
          if (selected.content.firstChild?.isInline) selected.content.forEach(node => { plain += composerInlineSource(node); });
          else plain = serializeComposerDocument(selectedDoc);
          try {
            const records = contexts.map(payload => payload.type === "attachment" ? { type: "attachment" as const, attachment: readPreparedComposerAttachment(contextLive.current.draft.targetKey, payload.attachment.id) } : payload.type === "native" ? { type: "native" as const, item: { input: payload.item.input } } : payload);
            event.clipboardData?.setData(CONTEXT_CLIPBOARD_TYPE, JSON.stringify({ version: 1, text: plain, contexts: records, quote, quoteThreadId: remoteId }));
            event.clipboardData?.setData("text/plain", contextClipboardPlainText([plain, quote ? `[Quoted response ${quote.messageId}]\n${quote.text}` : ""].filter(Boolean).join("\n\n"), records));
          } catch (cause) { event.preventDefault(); setContextError(String(cause)); return true; }
          event.preventDefault(); view.dispatch(view.state.tr.deleteSelection()); return true;
        },
        compositionstart: () => {
          composing.current = true;
          live.current.props.suggestions?.onCompositionStart();
          return false;
        },
        compositionend: (view) => {
          composing.current = false;
          compositionEnded.current = Date.now();
          requestAnimationFrame(() => {
            if (view.isDestroyed) return;
            const source = serializeComposerDocument(view.state.doc);
            lastText.current = source;
            aui.composer.setText(source);
            live.current.props.suggestions?.onCompositionEnd(composerSourceCursor(view.state.doc, view.state.selection.head), view.state.selection.$from.parent.type.name === "codeBlock");
          });
          return false;
        },
      },
      handlePaste: (view, event) => {
        if (live.current.disabled) return false;
        const structured = event.clipboardData?.getData(CONTEXT_CLIPBOARD_TYPE);
        if (structured) {
          event.preventDefault();
          importStructuredContext(view, structured, event.clipboardData?.getData("text/plain") ?? "");
          return true;
        }
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length) {
          // File pastes must never fall through into unsafe browser navigation or HTML.
          event.preventDefault();
          if (aui.thread.getState().capabilities.attachments) for (const file of files) void aui.composer.addAttachment(file).catch(() => {
            // The runtime publishes composer.attachmentAddError, like its native input.
          });
          return true;
        }
        const source = event.clipboardData?.getData("text/plain");
        if (source === undefined || source === "") return false;
        event.preventDefault();
        if (view.state.selection.$from.parent.type.name === "codeBlock") {
          view.dispatch(view.state.tr.insertText(source));
          return true;
        }
        let language: string | undefined;
        try {
          const metadata: unknown = JSON.parse(event.clipboardData?.getData("vscode-editor-data") || "null");
          if (metadata && typeof metadata === "object" && "mode" in metadata && typeof metadata.mode === "string" && /^[\w.+#-]+$/.test(metadata.mode)) language = metadata.mode;
        } catch { /* Clipboard metadata is optional; plain text remains authoritative. */ }
        if (!source.includes("\n")) {
          view.dispatch(view.state.tr.insertText(source));
          return true;
        }
        view.dispatch(view.state.tr.replaceSelection(composerPasteSlice(view.state.schema, source, language)).scrollIntoView());
        return true;
      },
      clipboardTextSerializer: (slice, view) => {
        if (slice.content.firstChild?.isInline) {
          let source = "";
          slice.content.forEach((node) => { source += composerInlineSource(node); });
          return source;
        }
        return serializeComposerDocument(view.state.schema.topNodeType.create(null, slice.content));
      },
    },
    onUpdate: ({ editor: current, transaction }) => {
      // State-only updates (including editability) are not draft changes. The
      // remote runtime may still expose its immutable empty-thread placeholder.
      if (!transaction.docChanged) return;
      const source = serializeComposerDocument(current.state.doc);
      lastText.current = source;
      const composer = aui.composer.getState();
      if (source !== composer.text) aui.composer.setText(source);
      const citation = readComposerCitation(current.state.doc);
      if (citation?.text !== composer.quote?.text || citation?.messageId !== composer.quote?.messageId) aui.composer.setQuote(citation);
      if (!syncingContexts.current) {
        const payloads = readComposerContexts(current.state.doc);
        const nativeItems = payloads.flatMap(payload => payload.type === "native" ? [payload.item] : []);
        const pmItems = payloads.flatMap(payload => payload.type === "pm" ? [payload.reference] : []);
        contextLive.current.draft.replaceItems(nativeItems);
        if (JSON.stringify(pmItems) !== JSON.stringify(contextLive.current.references)) {
          if (contextLive.current.editing) setEditedContextReferences(contextLive.current.draft.targetKey, pmItems);
          else contextLive.current.workspace.replaceReferences(pmItems);
        }
        const wanted = payloads.flatMap(payload => payload.type === "attachment" ? [payload.attachment] : []);
        const draft = contextLive.current.draft;
        const stillSelected = (id: string) => !current.isDestroyed && readComposerContexts(current.state.doc).some(payload => payload.type === "attachment" && payload.attachment.id === id);
        for (const id of restoringAttachments.current) if (!wanted.some(attachment => attachment.id === id)) {
          restoringAttachments.current.delete(id); setMessageContextBlocker(draft.targetKey, `attachment:${id}`, undefined);
        }
        for (const attachment of composer.attachments) if (!wanted.some(value => value.id === attachment.id)) {
          void aui.composer.attachment({ id: attachment.id }).remove().then(() => { if (draft.isCurrent()) setMessageContextBlocker(draft.targetKey, `attachment:${attachment.id}`, undefined); }).catch(cause => { if (draft.isCurrent()) setMessageContextBlocker(draft.targetKey, `attachment:${attachment.id}`, `Attachment removal failed; its bytes are retained. ${String(cause)}`); });
        }
        for (const attachment of wanted) if (!composer.attachments.some(value => value.id === attachment.id) && !restoringAttachments.current.has(attachment.id)) {
          restoringAttachments.current.add(attachment.id);
          setMessageContextBlocker(draft.targetKey, `attachment:${attachment.id}`, "Restoring attachment bytes; sending is paused.");
          void prepareComposerContextAttachment(draft.targetKey, attachment).then(async serialized => {
            if (!draft.isCurrent() || !stillSelected(attachment.id)) return;
            await aui.composer.addAttachment(serialized);
            if (!draft.isCurrent()) return;
            if (!stillSelected(attachment.id)) await aui.composer.attachment({ id: attachment.id }).remove();
            restoringAttachments.current.delete(attachment.id);
            setMessageContextBlocker(draft.targetKey, `attachment:${attachment.id}`, undefined);
          }).catch(cause => {
            if (draft.isCurrent() && stillSelected(attachment.id)) setMessageContextBlocker(draft.targetKey, `attachment:${attachment.id}`, `Attachment could not be restored. Remove it or attach it again. ${String(cause)}`);
          });
        }
      }
      if (!composing.current) live.current.props.suggestions?.onInput(composerSourceCursor(current.state.doc, current.state.selection.head), current.isActive("codeBlock"));
      if (normalizing.current || composing.current) return;
      cancelAnimationFrame(frame.current ?? 0);
      frame.current = requestAnimationFrame(() => {
        if (current.isDestroyed || composing.current) return;
        normalizing.current = true;
        normalizeComposerReferences(current);
        normalizing.current = false;
        applyComposerDirections(current.view.dom);
      });
    },
    onSelectionUpdate: ({ editor: current }) => {
      if (!composing.current) live.current.props.suggestions?.onInput(composerSourceCursor(current.state.doc, current.state.selection.head), current.isActive("codeBlock"));
    },
  });
  const state = useEditorState({ editor, selector: ({ editor: current }) => current ? {
    link: current.isActive("link"), task: current.isActive("taskItem"),
  } : null });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled, false);
    const attributes: Record<string, string> = { role: props.suggestions ? "combobox" : "textbox", "aria-multiline": "true", "aria-label": props.label,
      "aria-disabled": String(disabled), "data-placeholder": props.placeholder, class: "aui-composer-input rich-composer-editor", spellcheck: "true" };
    for (const [key, value] of Object.entries(props.suggestions?.inputAria ?? {})) if (value !== undefined) attributes[key] = String(value);
    editor.setOptions({ editorProps: { ...editor.options.editorProps, attributes } });
  }, [editor, disabled, props.label, props.placeholder, props.suggestions?.inputAria]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || text === lastText.current || composing.current) return;
    editor.commands.setContent(parseComposerDocument(text, aui.composer.getState().quote, contextLive.current.payloads), { emitUpdate: false });
    lastText.current = text;
    editor.commands.setTextSelection(composerDocumentCursor(editor.state.doc, text.length));
  }, [aui, editor, text, quote]);

  // Direction is presentation only; the serialized draft keeps its exact text.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const pending = requestAnimationFrame(() => { if (!editor.isDestroyed) applyComposerDirections(editor.view.dom); });
    return () => cancelAnimationFrame(pending);
  }, [editor, text, quote, contextPayloads]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || disabled) return;
    const handlePasteOutside = (event: ClipboardEvent) => {
      if (!editor || editor.isDestroyed) return;
      // Two mounted composers (thread and message edit) would both claim the paste.
      if (document.querySelectorAll(".rich-composer").length > 1) return;
      const path = event.composedPath();
      const inside = (selector: string) => path.some(target => target instanceof Element && target.closest(selector));
      if (!shouldFocusComposerForPaste({
        eventDefaultPrevented: event.defaultPrevented,
        insideEditable: inside(COMPOSER_EDITABLE_SELECTOR),
        insideInteractive: inside(COMPOSER_INTERACTIVE_SELECTOR),
        floatingLayerOpen: !!document.querySelector(COMPOSER_FLOATING_LAYER_SELECTOR),
      })) return;
      const data = event.clipboardData;
      if (!data) return;
      const structured = data.getData(CONTEXT_CLIPBOARD_TYPE);
      const source = data.getData("text/plain");
      const files = Array.from(data.files ?? []);
      if (!structured && !source && !files.length) return;
      event.preventDefault();
      event.stopPropagation();
      if (structured) {
        editor.commands.focus("end");
        importStructuredContext(editor.view, structured, source);
        return;
      }
      if (files.length) {
        if (aui.thread.getState().capabilities.attachments) for (const file of files) void aui.composer.addAttachment(file).catch(() => {});
        return;
      }
      if (source.includes("\n")) {
        const slice = composerPasteSlice(editor.state.schema, source);
        editor.chain().focus("end").command(({ tr, dispatch }) => { if (dispatch) tr.replaceSelection(slice); return true; }).run();
      } else editor.chain().focus("end").insertContent(source).run();
    };
    window.addEventListener("paste", handlePasteOutside, true);
    return () => window.removeEventListener("paste", handlePasteOutside, true);
  }, [aui, editor, disabled]);

  useEffect(() => {
    if (!editor) return;
    // Read the current runtime rather than a stale passive-effect quote snapshot.
    const runtimeQuote = aui.composer.getState().quote;
    const citations: Array<{ from: number; to: number }> = [];
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === "composerCitation") citations.push({ from: position, to: position + node.nodeSize });
    });
    const citation = readComposerCitation(editor.state.doc);
    if (citations.length === 1 && citation?.text === runtimeQuote?.text && citation?.messageId === runtimeQuote?.messageId) return;
    if (!runtimeQuote && !citations.length) return;
    // A runtime quote update must not replace newly resolved context with the editor's previous context set.
    syncingContexts.current = true;
    try {
      editor.commands.command(({ tr, state, dispatch }) => {
        for (const current of citations.reverse()) tr.delete(current.from, current.to);
        if (runtimeQuote) {
          const chip = state.schema.nodes.composerCitation!.create({ quote: runtimeQuote });
          if (tr.doc.firstChild?.type.name === "paragraph") tr.insert(1, chip);
          else tr.insert(0, state.schema.nodes.paragraph!.create({ citationOnly: true }, chip));
        }
        if (dispatch) dispatch(tr.setMeta("addToHistory", false));
        return true;
      });
    } finally {
      syncingContexts.current = false;
    }
  }, [aui, editor, quote]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || composing.current) return;
    const actual = readComposerContexts(editor.state.doc);
    const desired = [...contextPayloads, ...actual.filter(payload => payload.type === "attachment" && restoringAttachments.current.has(payload.attachment.id) && !contextPayloads.some(candidate => candidate.type === "attachment" && candidate.attachment.id === payload.attachment.id))];
    if (JSON.stringify(actual) === JSON.stringify(desired)) return;
    syncingContexts.current = true;
    editor.commands.command(({ tr, state: editorState, dispatch }) => {
      const positions: Array<{ from: number; to: number }> = [];
      tr.doc.descendants((node, position) => { if (node.type.name === "composerContext") positions.push({ from: position, to: position + node.nodeSize }); });
      for (const position of positions.reverse()) tr.delete(position.from, position.to);
      const nodes = desired.map(payload => editorState.schema.nodes.composerContext!.create({ payload }));
      if (nodes.length) {
        if (tr.doc.firstChild?.type.name === "paragraph") tr.insert(1, nodes);
        else tr.insert(0, editorState.schema.nodes.paragraph!.create({ citationOnly: true }, nodes));
      }
      if (dispatch) dispatch(tr);
      return true;
    });
    syncingContexts.current = false;
  }, [editor, contextPayloads]);

  useEffect(() => {
    if (!editor) return;
    const handle: RichComposerHandle = {
      focus: () => editor.commands.focus(),
      setSelectionRange: (start, end) => editor.commands.setTextSelection({ from: composerDocumentCursor(editor.state.doc, start), to: composerDocumentCursor(editor.state.doc, end) }),
    };
    const ref = props.suggestions?.inputRef;
    if (ref) ref.current = handle;
    editorRef.current = editor;
    if (!disabled) editor.commands.focus("end", { scrollIntoView: false });
    return () => { if (ref?.current === handle) ref.current = null; if (editorRef.current === editor) editorRef.current = null; };
  }, [editor, disabled, props.suggestions?.inputRef]);
  useEffect(() => () => cancelAnimationFrame(frame.current ?? 0), []);

  const removeAttachment = (id: string) => {
    void aui.composer.attachment({ id }).remove().catch(cause => setContextError(cause instanceof Error ? cause.message : String(cause)));
  };
  const applyLink = () => {
    if (!editor) return;
    const href = linkValue.trim();
    if (!/^(?:https?:\/\/|mailto:)[^\s]+$/iu.test(href)) {
      setLinkError(t("请输入 http(s):// 或 mailto: 链接。", "Enter an http(s):// or mailto: link."));
      return;
    }
    const range = linkRange.current ?? { from: editor.state.selection.from, to: editor.state.selection.to };
    if (range.from === range.to) {
      setLinkError(t("先选中要链接的文字。", "Select the text to link first."));
      return;
    }
    editor.chain().focus().setTextSelection(range).setMark("link", { href }).run();
    setLinkOpen(false);
    setLinkValue("");
    setLinkError(undefined);
  };
  const removeLink = () => {
    if (!editor) return;
    const range = linkRange.current ?? { from: editor.state.selection.from, to: editor.state.selection.to };
    editor.chain().focus().setTextSelection(range).unsetMark("link").run();
    setLinkOpen(false);
    setLinkValue("");
    setLinkError(undefined);
  };
  const acceptsContextDrop = (types: readonly string[]) => types.includes(COMPOSER_CONTEXT_DRAG_TYPE);
  return <div className="rich-composer" data-editing={props.editing || undefined} data-drop-active={dragActive ? "true" : undefined}
    onDragEnter={(event) => { if (acceptsContextDrop(event.dataTransfer.types)) { event.preventDefault(); setDragActive(true); } }}
    onDragOver={(event) => { if (!acceptsContextDrop(event.dataTransfer.types)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragActive(true); }}
    onDragLeave={(event) => { const next = event.relatedTarget; if (!(next instanceof globalThis.Node) || !event.currentTarget.contains(next)) setDragActive(false); }}
    onDrop={(event) => {
      setDragActive(false);
      // Foreign drags keep their own drop behaviour.
      if (!acceptsContextDrop(event.dataTransfer.types)) return;
      event.preventDefault();
      const raw = event.dataTransfer.getData(COMPOSER_CONTEXT_DRAG_TYPE);
      if (!raw || !editor) return;
      editor.commands.focus("end");
      importStructuredContext(editor.view, raw, event.dataTransfer.getData("text/plain"));
    }}>
    <ComposerAttachmentStrip attachments={attachments} disabled={disabled} onRemove={removeAttachment} />
    <EditorContent editor={editor} />
    {composerPromptTooLong(text) && <p role="alert" className="px-2 text-xs text-destructive">{t(`消息超过 ${COMPOSER_PROMPT_LIMIT.toLocaleString()} 字符，请缩短后发送。`, `Message exceeds ${COMPOSER_PROMPT_LIMIT.toLocaleString()} characters; shorten it before sending.`)}</p>}
    {contextError && <p role="alert" className="px-2 text-xs text-destructive">{contextError}</p>}
    {planNotice && <p role="status" className="px-2 text-xs text-muted-foreground">{planNotice}</p>}
    <div className="rich-composer-tools">
      <button type="button" disabled={disabled || !editor} aria-pressed={!!state?.task} title={t("插入任务清单；勾选后序列化为 - [x]", "Insert a task list; checked items serialize as - [x]")}
        onClick={() => {
          if (!editor) return;
          if (editor.isActive("taskItem")) { editor.chain().focus().splitListItem("taskItem").run(); return; }
          editor.chain().focus().insertContent({ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false, space: "" }, content: [{ type: "paragraph" }] }] }).run();
        }}>
        <CheckSquareIcon aria-hidden="true" />{t("任务", "Task")}
      </button>
      <button ref={linkButton} type="button" disabled={disabled || !editor} aria-pressed={!!state?.link} aria-expanded={linkOpen} title={t("把选中的文字变成 Markdown 链接", "Turn the selected text into a Markdown link")}
        onClick={() => {
          if (!editor) return;
          const { from, to } = editor.state.selection;
          linkRange.current = { from, to };
          const href = editor.getAttributes("link").href;
          setLinkValue(typeof href === "string" ? href : "");
          setLinkOpen(true);
          setLinkError(from === to ? t("先选中要链接的文字。", "Select the text to link first.") : undefined);
        }}>
        <LinkIcon aria-hidden="true" />{t("链接", "Link")}
      </button>
    </div>
    {linkOpen && <div className="rich-composer-link">
      <input autoFocus type="url" value={linkValue} maxLength={2048} spellCheck={false} aria-label={t("链接地址", "Link address")}
        placeholder="https://…" onChange={(event) => { setLinkValue(event.currentTarget.value); setLinkError(undefined); }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Enter") { event.preventDefault(); applyLink(); }
          if (event.key === "Escape") { event.preventDefault(); setLinkOpen(false); setLinkError(undefined); linkButton.current?.focus(); }
        }} />
      <button type="button" className="text-xs underline" onClick={applyLink}>{t("应用", "Apply")}</button>
      {state?.link && <button type="button" className="text-xs underline" onClick={removeLink}>{t("移除链接", "Remove link")}</button>}
      <button type="button" className="text-xs underline" onClick={() => { setLinkOpen(false); setLinkError(undefined); linkButton.current?.focus(); }}>{t("取消", "Cancel")}</button>
      {linkError && <p role="alert" className="text-xs text-destructive">{linkError}</p>}
    </div>}
  </div>;
}
