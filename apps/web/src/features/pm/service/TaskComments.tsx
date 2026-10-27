import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { ApiError, type Command, type CommandReceipt, type TaskComment } from '@contracts';
import { MessageContent } from '@/components/blocks/message-content';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useDisplayDateTime } from '@/features/workspace/preference-format';
import { useWorkspaceStore } from '@/providers/app-providers';
import { usePmCommand, usePmService } from './pm-service';
import { PmCommandError, PmServiceError } from './pm-errors';
import { allowed, CommandNotice, useText } from './pm-ui';
import { emptyCommentDraft, settleCommentDraft, type CommentDraft, type CommentDraftStore } from './task-comments-model';
import { useTaskCommentDrafts, useTaskCommentHistory, useTaskComments } from './use-task-comments';
import { PersonalMentionPicker } from './PersonalMentionPicker';
import './task-comments.css';

function CommentHistory({ taskId, projectId, commentId }: { taskId: string; projectId: string; commentId: string }) {
  const [open, setOpen] = useState(false);
  const query = useTaskCommentHistory(taskId, projectId, commentId, open);
  const t = useText();
  const display = useDisplayDateTime();
  return <details onToggle={event => setOpen(event.currentTarget.open)} className="task-comment-history"><summary>{t('不可变历史', 'Immutable history')}</summary>{open && <>
    <p>{t('删除是可恢复的隐藏，不是历史抹除；历史正文仍向当前项目读者可见。', 'Deletion is a recoverable hide, not erasure; historical bodies remain visible to current project readers.')}</p>
    {query.isPending && <p role="status">{t('读取历史…', 'Loading history…')}</p>}
    {query.error && <div role="alert">{query.error.message}<Button variant="outline" onClick={() => { void query.refetch(); }}>{t('重试读取', 'Retry read')}</Button></div>}
    {query.data?.map(revision => <article key={revision.version}><p><strong>v{revision.version} · {revision.action}</strong> · {revision.actorId} · <time dateTime={revision.occurredAt}>{display.dateTime(revision.occurredAt)}</time></p><MessageContent content={revision.content} /></article>)}
  </>}</details>;
}

type EditorProps = { taskId: string; projectId: string; draftKey: string; draft: CommentDraft; store: CommentDraftStore; canWrite: boolean; comment?: TaskComment; onRefresh: () => void };
function CommentEditor({ taskId, projectId, draftKey, draft, store, canWrite, comment, onRefresh }: EditorProps) {
  const command = usePmCommand();
  const { client, workspace } = usePmService();
  const t = useText();
  const spellcheck = useWorkspaceStore(state => state.spellcheck);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [preview, setPreview] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const locked = command.pending || !!command.unknownCommand || !!draft.attempt || checking;
  const conflict = !!comment && draft.baseVersion !== comment.version;
  const update = (change: Partial<CommentDraft>) => store.commit(current => ({ ...current, [draftKey]: { ...(current[draftKey] ?? emptyCommentDraft()), ...change } }));
  const remove = () => store.commit(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== draftKey)));
  const settle = (receipt: CommandReceipt) => {
    store.commit(current => ({ ...current, [draftKey]: settleCommentDraft(current[draftKey] ?? draft, receipt) }));
    onRefresh();
  };
  async function recover() {
    if (!draft.attempt || !workspace || checking) return;
    setChecking(true); setError('');
    try {
      const receipt = command.unknownCommand?.commandId === draft.attempt.commandId ? await command.reconcile() : await client.getCommandReceipt(workspace.id, draft.attempt.commandId);
      if (receipt) settle(receipt);
      else setError(t('尚无可访问收据，不代表失败；原稿与命令保留。', 'No accessible receipt yet; this does not prove failure. The draft and original command remain.'));
    } catch (cause) { if (cause instanceof PmCommandError) settle(cause.receipt); setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setChecking(false); }
  }
  async function submit() {
    if (!canWrite || locked || conflict || !draft.content.trim()) return;
    setError('');
    const envelope = { commandId: crypto.randomUUID(), targetId: taskId, projectId };
    const request: Command = comment
      ? { ...envelope, commandType: 'UpdateTaskComment', payload: { commentId: comment.id, content: draft.content }, expectedVersions: { [comment.id]: draft.baseVersion! } }
      : { ...envelope, commandType: 'CreateTaskComment', payload: { content: draft.content } };
    if (!update({ attempt: request, confirmed: false })) { setError(t('草稿备份失败，未发送评论。请保持此页并重试备份。', 'Draft backup failed. No comment was sent. Keep this page open and retry backup.')); update({ attempt: null }); return; }
    try { const receipt = await command.execute(request); settle(receipt); remove(); }
    catch (cause) {
      if (cause instanceof PmCommandError) settle(cause.receipt);
      else if (cause instanceof PmServiceError && ['recovery_storage_unavailable', 'command_pending'].includes(cause.code)) update({ attempt: null });
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return <div className="task-comment-editor" data-comment-editor={draftKey}>
    {draft.attempt ? <div role="status"><p>{draft.confirmed ? t('原命令已确认提交；请清理已提交原稿后再开始新的编辑，避免重复发布。', 'The original command is confirmed committed. Clear this submitted draft before starting another edit to avoid duplicates.') : t('评论结果待核对；原稿与 commandId 已保留，不自动重发。', 'Check the original comment outcome. Draft and commandId are retained; no automatic resend.')}</p><code>{draft.attempt.commandId}</code><div className="task-comment-actions">{draft.confirmed ? <Button variant="outline" onClick={remove}>{t('清理已提交原稿', 'Clear submitted draft')}</Button> : <Button variant="outline" disabled={checking || command.pending} onClick={() => { void recover(); }}>{t('核对原评论命令', 'Check original comment command')}</Button>}</div></div> : <>
      {conflict && <div role="alert"><p>{t('评论已变化，原稿未覆盖。比较当前正文后，显式采用新版本作为基线。', 'The comment changed; your draft is preserved. Compare the current body, then explicitly adopt its version as the base.')}</p><details><summary>{t('编辑开始时的正文', 'Original body at edit start')}</summary><pre>{draft.original}</pre></details><Button variant="outline" disabled={!canWrite || !!comment?.deletedAt} onClick={() => update({ baseVersion: comment!.version, original: comment!.content ?? '' })}>{t('保留原稿并采用当前版本基线', 'Keep draft and adopt current version')}</Button></div>}
      <label><span>{comment ? t('编辑评论 Markdown', 'Edit comment Markdown') : t('新评论 Markdown', 'New comment Markdown')}</span><Textarea ref={textarea} value={draft.content} maxLength={16000} rows={4} spellCheck={spellcheck} disabled={!canWrite || locked || !!comment?.deletedAt} onChange={event => update({ content: event.target.value })} /></label>
      <PersonalMentionPicker taskId={taskId} projectId={projectId} disabled={!canWrite || locked || !!comment?.deletedAt} onInsert={token => {
        const start = textarea.current?.selectionStart ?? draft.content.length, end = textarea.current?.selectionEnd ?? start;
        update({ content: `${draft.content.slice(0, start)}${token}${draft.content.slice(end)}` });
      }} />
      <div className="task-comment-actions"><Button disabled={!canWrite || locked || conflict || !draft.content.trim() || !!comment?.deletedAt} onClick={() => { void submit(); }}>{comment ? t('保存评论', 'Save comment') : t('发布评论', 'Post comment')}</Button><Button variant="ghost" onClick={() => setPreview(!preview)}>{t('Markdown 预览', 'Markdown preview')}</Button>{comment && <Button variant="ghost" disabled={locked} onClick={remove}>{t('放弃此编辑原稿', 'Discard this edit draft')}</Button>}</div>
      {preview && <MessageContent content={draft.content} />}
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function TaskComments({ taskId, projectId, writable = true }: { taskId: string; projectId: string; writable?: boolean }) {
  const { actor, workspace, capabilities } = usePmService();
  const command = usePmCommand();
  const query = useTaskComments(taskId, projectId);
  const { drafts, store } = useTaskCommentDrafts(taskId, projectId);
  const location = useLocation();
  useEffect(() => {
    if (!/^#comment-[0-9a-f-]{36}$/.test(location.hash)) return;
    const frame = requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(frame);
  }, [location.hash, query.data]);
  const t = useText();
  const display = useDisplayDateTime();
  const [error, setError] = useState('');
  const canWrite = writable && capabilities?.business.enabled === true && allowed(workspace, 'intent.propose', projectId) && !!query.data && !query.error;
  const refresh = () => { void query.refetch(); };
  async function changeVisibility(comment: TaskComment) {
    if (!canWrite || command.pending || command.unknownCommand || drafts[comment.id]) return;
    const request: Command = { commandId: crypto.randomUUID(), commandType: comment.deletedAt ? 'RestoreTaskComment' : 'DeleteTaskComment', targetId: taskId, projectId, payload: { commentId: comment.id }, expectedVersions: { [comment.id]: comment.version } };
    if (!store.commit(current => ({ ...current, [comment.id]: { content: comment.content ?? '', original: comment.content ?? '', baseVersion: comment.version, attempt: request, confirmed: false } }))) { store.commit(current => ({ ...current, [comment.id]: { ...current[comment.id]!, attempt: null } })); setError(t('备份失败，未发送命令。', 'Backup failed; no command was sent.')); return; }
    setError('');
    try { await command.execute(request); store.commit(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== comment.id))); refresh(); }
    catch (cause) {
      if (cause instanceof PmCommandError) store.commit(current => ({ ...current, [comment.id]: settleCommentDraft(current[comment.id]!, cause.receipt) }));
      else if (cause instanceof PmServiceError && ['recovery_storage_unavailable', 'command_pending'].includes(cause.code)) store.commit(current => ({ ...current, [comment.id]: { ...current[comment.id]!, attempt: null } }));
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  if (!allowed(workspace, 'domain.read', projectId)) return null;
  return <section className="task-comments" aria-label={t('任务评论', 'Task comments')} data-testid="task-comments">
    <header><h3>{t('评论', 'Comments')} {query.data && <span>({query.data.length})</span>}</h3><Button variant="ghost" disabled={query.isFetching} onClick={refresh}>{t('刷新评论', 'Refresh comments')}</Button></header>
    <p className="task-comment-note">{t('评论绑定已保存任务与项目，独立于 Markdown 正文和任务状态。仅作者可编辑、隐藏与恢复；删除保留可读取的历史。', 'Comments belong to the saved task and project, separate from Markdown and task status. Only the author can edit, hide or restore; deletion retains readable history.')}</p>
    <CommandNotice />
    {store.persistenceError() && <div role="alert">{t('浏览器原稿备份不可用。输入仍保留在本页，请勿关闭；重试成功后才能发送。', 'Browser draft backup is unavailable. Input remains in this page; do not close it. Retry backup before sending.')}<Button variant="outline" onClick={() => { store.flush(); }}>{t('重试备份', 'Retry backup')}</Button></div>}
    {query.isPending && <p role="status">{t('加载评论…', 'Loading comments…')}</p>}
    {query.error && <p role="alert">{query.error instanceof ApiError && query.error.code === 'task_comment_project_changed' ? t('任务已转移项目。评论历史保留在原项目，未自动转给新项目读者；需先讨论并显式决定历史迁移和访问策略。此状态不是网络故障，也不表示没有历史。', 'This task moved projects. Comment history remains in its original project and was not transferred to a new audience. History migration and access need an explicit decision; this is not a network failure or an empty history.') : <>{t('评论读取失败，不表示没有评论：', 'Comments could not be read; this is not an empty list: ')}{query.error.message}</>}</p>}
    {error && <p role="alert">{error}</p>}
    {query.data?.length === 0 && <p>{t('尚无评论。', 'No comments yet.')}</p>}
    <ol className="task-comment-list">{query.data?.map(comment => <li id={`comment-${comment.id}`} key={comment.id} data-comment-id={comment.id}>
      <div className="task-comment-meta"><strong>{comment.authorId === actor?.id ? actor.name : comment.authorId}</strong><time dateTime={comment.createdAt}>{display.dateTime(comment.createdAt)}</time><span>v{comment.version}</span></div>
      {comment.deletedAt ? <p className="task-comment-deleted">{t('作者已隐藏此评论；历史仍保留，可由作者恢复。', 'The author hid this comment. History is retained and the author can restore it.')} · <time dateTime={comment.deletedAt}>{display.dateTime(comment.deletedAt)}</time></p> : <MessageContent content={comment.content ?? ''} />}
      {comment.authorId === actor?.id && <div className="task-comment-actions">{!comment.deletedAt && <Button variant="ghost" disabled={!canWrite || command.pending || !!command.unknownCommand || !!drafts[comment.id]} onClick={() => { store.commit(current => ({ ...current, [comment.id]: { content: comment.content ?? '', original: comment.content ?? '', baseVersion: comment.version, attempt: null, confirmed: false } })); }}>{t('编辑评论', 'Edit comment')}</Button>}<Button variant="ghost" disabled={!canWrite || command.pending || !!command.unknownCommand || !!drafts[comment.id]} onClick={() => { void changeVisibility(comment); }}>{comment.deletedAt ? t('恢复评论', 'Restore comment') : t('隐藏评论（保留历史）', 'Hide comment (retain history)')}</Button></div>}
      {drafts[comment.id] && <CommentEditor taskId={taskId} projectId={projectId} draftKey={comment.id} draft={drafts[comment.id]!} store={store} comment={comment} canWrite={canWrite && comment.authorId === actor?.id} onRefresh={refresh} />}
      <CommentHistory taskId={taskId} projectId={projectId} commentId={comment.id} />
    </li>)}</ol>
    {query.data && <CommentEditor taskId={taskId} projectId={projectId} draftKey="new" draft={drafts.new ?? emptyCommentDraft()} store={store} canWrite={canWrite} onRefresh={refresh} />}
    {!canWrite && query.data && <p className="task-comment-note">{t('当前只读；发布与作者管理仍需此项目 intent.propose、有效任务及可写项目。', 'Read only: posting and author management require current intent.propose in this project, an available task and writable project.')}</p>}
  </section>;
}
