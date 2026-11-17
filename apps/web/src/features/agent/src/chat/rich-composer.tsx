import { useAui, useAuiState, type QuoteInfo } from "@assistant-ui/react";
import {
  EditorContent, Node, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer,
  useEditor, useEditorState, type JSONContent, type NodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type AriaAttributes, type MutableRefObject } from "react";
import { CodeIcon, FileIcon, QuoteIcon, XIcon } from "lucide-react";
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


function ContextView({ node, deleteNode }: NodeViewProps) {
  const payload = node.attrs.payload as ComposerContextPayload | undefined;
  return <NodeViewWrapper as="span" className="rich-composer-context inline-flex max-w-full items-center gap-0.5" contentEditable={false}>
    {payload?.type === "native" ? <MessageContextChip item={payload.item} /> : payload?.type === "pm" ? <PmContextChip reference={payload.reference} /> : payload?.type === "attachment" ? <span data-composer-attachment-anchor="" /> : <span role="status">Context unavailable</span>}
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

function CodeBlockView({ node, updateAttributes, editor, getPos }: NodeViewProps) {
  const t = useAgentText();
  const id = useId();
  return <NodeViewWrapper className="rich-composer-code">
    <div className="rich-composer-code-toolbar" contentEditable={false}>
      <CodeIcon aria-hidden="true" />
      <label htmlFor={id}>{t("语言", "Language")}</label>
      <input id={id} value={String(node.attrs.language ?? "")} placeholder={t("纯文本", "Plain text")} spellCheck={false}
        aria-label={t("代码块语言", "Code block language")} maxLength={80}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          // Node-view inputs bypass editor key handlers; never implicitly submit.
          event.preventDefault();
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          const position = getPos();
          if (typeof position === "number") editor.commands.setTextSelection(position + 1 + node.content.size);
          editor.commands.focus();
        }}
        onChange={(event) => updateAttributes({ language: event.currentTarget.value.replace(/[^\w.+#-]/g, "") })} />
      <span>{t("Ctrl / ⌘ + Enter 离开代码块", "Ctrl / ⌘ + Enter exits code")}</span>
    </div>
    <pre spellCheck={false}><NodeViewContent<"code"> as="code" /></pre>
  </NodeViewWrapper>;
}

function composerExtensions() {
  return [
    StarterKit.configure({
      blockquote: false, bulletList: false, codeBlock: false,
      dropcursor: false, heading: false, horizontalRule: false, link: false,
      listItem: false, listKeymap: false, orderedList: false, paragraph: false, trailingNode: false, underline: false,
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
      addNodeView: () => ReactNodeViewRenderer(CodeBlockView),
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
    ComposerReference, ComposerCitation, ComposerContext,
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
  const runtimeDisabled = useAuiState((state) => state.thread.isLoading || state.thread.isDisabled || state.composer.dictation?.inputDisabled);
  const disabled = props.disabled || !!runtimeDisabled;
  const live = useRef({ props, disabled });
  live.current = { props, disabled };
  const lastText = useRef(text);
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
        if (event.key !== "Enter") return false;
        // Browsers may emit one final non-composing Enter for the same IME commit.
        if (Date.now() - compositionEnded.current < 80) { event.preventDefault(); return true; }
        const inCode = view.state.selection.$from.parent.type.name === "codeBlock";
        if (inCode) return false;
        const thread = aui.thread.getState();
        if (event.shiftKey && (event.ctrlKey || event.metaKey) && thread.capabilities.queue && aui.composer.getState().canSend) {
          event.preventDefault();
          if (!composerPromptTooLong(aui.composer.getState().text) && !live.current.props.beforeSend?.()) aui.composer.send({ steer: true });
          return true;
        }
        if (event.shiftKey || event.altKey || (thread.isRunning && !thread.capabilities.queue && thread.voice === undefined)) return false;
        if (live.current.props.submitMode === "ctrlEnter" && !event.ctrlKey && !event.metaKey) return false;
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
            if (data.contexts.length !== inputs.length + pm.length + pastedAttachments.length || contextLive.current.draft.items.length + inputs.length > 20 || contextLive.current.references.length + pm.length > PM_REFERENCE_LIMIT) throw new Error("The pasted context exceeds the current limit or contains an unknown record.");
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
            const source = typeof data.text === "string" ? data.text : event.clipboardData?.getData("text/plain") ?? "";
            const current = contextLive.current;
            const originalDoc = view.state.doc;
            const ids = new Set(current.draft.items.map(item => item.input.contextId));
            if (inputs.some(input => ids.has(input.contextId))) throw new Error("This context is already selected. Remove it before pasting another copy.");
            const pmKeys = new Set(current.references.map(reference => JSON.stringify([reference.workspaceId, reference.projectId, reference.kind, reference.id])));
            const newPm = pm.filter(reference => !pmKeys.has(JSON.stringify([reference.workspaceId, reference.projectId, reference.kind, reference.id])));
            setContextError("Checking pasted context; the draft has not changed.");
            void current.draft.resolveInputs(inputs).then(resolved => {
              if (!current.draft.isCurrent() || view.isDestroyed) return;
              if (view.state.doc !== originalDoc) throw new Error("The draft changed during context resolution. Paste again; nothing was replaced.");
              const payloads: ComposerContextPayload[] = [...resolved.map(item => ({ type: "native" as const, item })), ...newPm.map(reference => ({ type: "pm" as const, reference })), ...pastedAttachments.map(attachment => ({ type: "attachment" as const, attachment: { ...attachment, status: { type: "complete" as const } } }))];
              const doc = view.state.schema.nodeFromJSON(parseComposerDocument(source, undefined, payloads));
              const from = doc.firstChild?.type.name === "paragraph" ? 1 : 0;
              const to = doc.content.size - (doc.lastChild?.type.name === "paragraph" ? 1 : 0);
              view.dispatch(view.state.tr.replaceSelection(doc.slice(from, to)).scrollIntoView());
              setContextError(undefined);
            }).catch(cause => { if (current.draft.isCurrent()) setContextError(String(cause)); });
          } catch (cause) { setContextError(cause instanceof Error ? cause.message : String(cause)); }
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
      });
    },
    onSelectionUpdate: ({ editor: current }) => {
      if (!composing.current) live.current.props.suggestions?.onInput(composerSourceCursor(current.state.doc, current.state.selection.head), current.isActive("codeBlock"));
    },
  });
  const state = useEditorState({ editor, selector: ({ editor: current }) => current ? { code: current.isActive("codeBlock") } : null });

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
    if (!disabled) editor.commands.focus("end", { scrollIntoView: false });
    return () => { if (ref?.current === handle) ref.current = null; };
  }, [editor, disabled, props.suggestions?.inputRef]);
  useEffect(() => () => cancelAnimationFrame(frame.current ?? 0), []);

  const removeAttachment = (id: string) => {
    void aui.composer.attachment({ id }).remove().catch(cause => setContextError(cause instanceof Error ? cause.message : String(cause)));
  };
  return <div className="rich-composer" data-editing={props.editing || undefined}>
    <ComposerAttachmentStrip attachments={attachments} disabled={disabled} onRemove={removeAttachment} />
    <EditorContent editor={editor} />
    {composerPromptTooLong(text) && <p role="alert" className="px-2 text-xs text-destructive">{t(`消息超过 ${COMPOSER_PROMPT_LIMIT.toLocaleString()} 字符，请缩短后发送。`, `Message exceeds ${COMPOSER_PROMPT_LIMIT.toLocaleString()} characters; shorten it before sending.`)}</p>}
    {contextError && <p role="alert" className="px-2 text-xs text-destructive">{contextError}</p>}
    <div className="rich-composer-tools">
      <button type="button" disabled={disabled || !editor} aria-pressed={!!state?.code} title={t("切换代码块；代码块内 Enter 换行", "Toggle code block; Enter inserts a line inside code")}
        onClick={() => {
          if (!editor) return;
          const { $from, $to } = editor.state.selection;
          if (!$from.depth || !$to.depth) return;
          const from = $from.before(1);
          const to = $to.after(1);
          const selected = editor.state.doc.slice(from, to).content;
          const inCode = $from.parent.type.name === "codeBlock";
          const body = inCode ? $from.parent.textContent : serializeComposerDocument(editor.schema.topNodeType.create(null, selected));
          const replacement: JSONContent[] = inCode ? parseComposerDocument(body).content! : [{ type: "codeBlock", ...(body ? { content: [{ type: "text", text: body }] } : {}) }];
          const citation = readComposerCitation(editor.schema.topNodeType.create(null, selected));
          if (citation) replacement.unshift({ type: "paragraph", attrs: { citationOnly: true }, content: [{ type: "composerCitation", attrs: { quote: citation } }] });
          const contexts = readComposerContexts(editor.schema.topNodeType.create(null, selected));
          if (contexts.length) replacement.unshift({ type: "paragraph", attrs: { citationOnly: true }, content: contexts.map(payload => ({ type: "composerContext", attrs: { payload } })) });
          editor.chain().focus().command(({ tr, state, dispatch }) => {
            const content = state.schema.nodeFromJSON({ type: "doc", content: replacement }).content;
            if (dispatch) dispatch(tr.replaceWith(from, to, content));
            return true;
          }).run();
        }}>
        <CodeIcon aria-hidden="true" />{t("代码", "Code")}
      </button>
      <span>{t("可粘贴代码、文件或截图", "Paste code, files, or screenshots")}</span>
    </div>
  </div>;
}
