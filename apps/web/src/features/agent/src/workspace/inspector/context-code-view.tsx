// Adapted from t3code components/diffs/{AnnotatableCodeView,DiffCommentAnnotation}.tsx
// and components/files/FilePreviewPanel.tsx @ 7379f1969b0f4b579327cf81299ef8cc3ddf8e9c (MIT).
// Host adaptation: read-only authorized inspector snapshots, resolved draft context, no editor writes.
import { parsePatchFiles, type CodeViewItem, type SelectedLineRange } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { useTheme } from "@agent/hooks/use-theme";
import { useChatBrowserPreferences } from "@agent/src/settings/browser-preferences";
import { useMessageContextDraft } from "../../chat/message-context";
import { useAgentText } from "../../i18n";
import { errorMessage } from "./api";
import { fileSelection, inspectorContentDigest, patchSelection } from "./context-selection";

type Snapshot = { path: string; contents: string; kind: "file" } | { path: string; contents: string; kind: "diff"; staged: boolean };
type Props = { snapshot: Snapshot; wrap?: boolean; line?: number };
type Annotation = { contextId: string; range: SelectedLineRange; version: number };

export function ContextCodeView({ snapshot, wrap = false, line }: Props) {
  const t = useAgentText();
  const [digest, setDigest] = useState<{ contents: string; value: string }>();
  const [digestError, setDigestError] = useState<string>();
  useEffect(() => {
    let current = true;
    setDigestError(undefined);
    void inspectorContentDigest(snapshot.contents).then(value => {
      if (current) setDigest({ contents: snapshot.contents, value });
    }).catch(cause => { if (current) setDigestError(errorMessage(cause)); });
    return () => { current = false; };
  }, [snapshot.contents]);
  if (digestError) return <p className="inspector-empty" role="alert">{digestError}</p>;
  if (digest?.contents !== snapshot.contents) return <p className="inspector-empty" role="status">{t("正在准备内容快照…", "Preparing content snapshot…")}</p>;
  return <SnapshotCodeView key={`${snapshot.kind}:${snapshot.path}:${snapshot.kind === "diff" ? snapshot.staged : ""}:${digest.value}`} snapshot={snapshot} contentDigest={digest.value} wrap={wrap} {...(line === undefined ? {} : { line })} />;
}

function SnapshotCodeView({ snapshot, contentDigest, wrap, line }: Props & { contentDigest: string }) {
  const t = useAgentText();
  const { theme } = useTheme();
  const { preferences } = useChatBrowserPreferences();
  const context = useMessageContextDraft();
  const viewer = useRef<CodeViewHandle<Annotation, undefined>>(null);
  const alive = useRef(false);
  const submitting = useRef(false);
  const annotationRevision = useRef(0);
  const [selectedLines, setSelectedLines] = useState<{ id: string; range: SelectedLineRange } | null>(line ? { id: snapshot.path, range: { start: line, end: line } } : null);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (line) viewer.current?.scrollTo({ type: "line", id: snapshot.path, lineNumber: line, align: "center" });
  }, [line, snapshot.path]);
  const parsed = useMemo(() => {
    if (snapshot.kind === "file") return { file: { name: snapshot.path, contents: snapshot.contents } };
    try {
      const files = parsePatchFiles(snapshot.contents, undefined, true).flatMap(patch => patch.files);
      if (files.length !== 1) throw new Error(t("此预览需要单个文件的差异。", "This preview requires a single-file diff."));
      return { fileDiff: files[0]! };
    } catch (cause) { return { error: errorMessage(cause) }; }
  }, [snapshot.kind, snapshot.path, snapshot.contents, t]);
  const items = useMemo<CodeViewItem<Annotation>[]>(() => {
    if ("file" in parsed && parsed.file) return [{ id: snapshot.path, type: "file", file: parsed.file, version: draft?.version ?? 0, annotations: draft ? [{ lineNumber: draft.range.end, metadata: draft }] : [] }];
    if ("fileDiff" in parsed && parsed.fileDiff) return [{ id: snapshot.path, type: "diff", fileDiff: parsed.fileDiff, version: draft?.version ?? 0, annotations: draft ? [{ side: draft.range.endSide ?? draft.range.side ?? "additions", lineNumber: draft.range.end, metadata: draft }] : [] }];
    return [];
  }, [draft, parsed, snapshot.path]);
  function beginComment(range: SelectedLineRange | null) {
    if (!range || !context.available || submitting.current) return;
    setSelectedLines({ id: snapshot.path, range });
    setDraft({ contextId: crypto.randomUUID(), range, version: ++annotationRevision.current });
    setComment("");
    setError(undefined);
  }
  async function attach() {
    if (!draft || submitting.current) return;
    const selection = snapshot.kind === "file" ? fileSelection(snapshot.contents, draft.range) : patchSelection(snapshot.contents, draft.range);
    if (!selection) { setError(t("所选行不在此内容快照内，请重新选择。", "The selected lines are outside this snapshot. Select them again.")); return; }
    submitting.current = true;
    setPending(true);
    setError(undefined);
    try {
      await context.add({
        contextId: draft.contextId,
        kind: "review-comment",
        source: snapshot.kind === "file" ? { type: "file", path: snapshot.path, contentDigest } : { type: "diff", path: snapshot.path, staged: snapshot.staged, contentDigest },
        selection,
        ...(snapshot.kind === "diff" ? { diffSelection: { start: draft.range.start, end: draft.range.end, side: draft.range.side ?? "additions", endSide: draft.range.endSide ?? draft.range.side ?? "additions" } } : {}),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      if (alive.current) { setDraft(null); setSelectedLines(null); setComment(""); }
    } catch (cause) { if (alive.current) setError(errorMessage(cause)); }
    finally { submitting.current = false; if (alive.current) setPending(false); }
  }
  if ("error" in parsed) return <p className="inspector-empty" role="alert">{parsed.error}</p>;
  return <CodeView<Annotation>
    ref={viewer}
    items={items}
    selectedLines={selectedLines}
    onSelectedLinesChange={setSelectedLines}
    options={{
      disableFileHeader: true,
      overflow: wrap ? "wrap" : "scroll",
      themeType: theme,
      diffStyle: preferences.diffLayout,
      enableLineSelection: context.available && !draft,
      enableGutterUtility: context.available && !draft,
      onGutterUtilityClick: beginComment,
      onLineSelectionEnd: beginComment,
    }}
    renderAnnotation={(annotation, _file, _item) => {
      const range = annotation.metadata.range;
      const first = `${snapshot.kind === "diff" && range.side === "deletions" ? "−" : ""}L${range.start}`;
      const last = `${snapshot.kind === "diff" && (range.endSide ?? range.side) === "deletions" ? "−" : ""}L${range.end}`;
      return <div data-diff-comment-annotation contentEditable={false} className="space-y-2 border-y border-border bg-background px-3 py-2 font-sans text-foreground caret-foreground selection:bg-primary selection:text-primary-foreground" onPointerDown={event => event.stopPropagation()}>
        <p className="text-xs text-muted-foreground">{first === last ? first : `${first} – ${last}`} · {t("加入当前草稿，不会发送", "Add to the current draft, without sending")}</p>
        <textarea autoFocus rows={3} maxLength={4000} value={comment} disabled={pending} className="w-full resize-y rounded border border-border bg-background px-2 py-1 text-sm" aria-label={t("所选行的评论（可选）", "Comment on selected lines (optional)")} placeholder={t("添加评论…", "Add a comment…")} onChange={event => setComment(event.target.value)} onKeyDown={event => {
          if (event.key === "Escape" && !pending) { event.preventDefault(); setDraft(null); setSelectedLines(null); }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void attach(); }
        }} />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button size="xs" variant="ghost" disabled={pending} onClick={() => { setDraft(null); setSelectedLines(null); setError(undefined); }}>{t("取消", "Cancel")}</Button>
          <Button size="xs" disabled={pending || !context.available} onClick={() => void attach()}><MessageSquarePlus aria-hidden="true" />{pending ? t("正在核验…", "Resolving…") : t("添加到对话", "Add to chat")}</Button>
        </div>
      </div>;
    }}
    disableWorkerPool
    className={snapshot.kind === "file" ? "inspector-file-virtualizer" : "min-h-0 flex-1 overflow-auto"}
  />;
}
