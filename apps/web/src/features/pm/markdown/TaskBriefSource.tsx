import { useEffect, useState } from 'react';
import { ApiError } from '@contracts';
import { inspectFrontmatter } from '@pm-markdown';
import type { TaskBriefSourceRef } from '@agent-workspace/contracts/task-brief';
import type { WorkspaceController } from './controller';
import { ApiError as CoreApiError } from './api';
import { usePrivateQuery } from '../service/pm-service';
import { guidanceReadFailure, guidanceSnapshot, guidanceSourceMatches, guidanceSourceOffset } from './task-brief-presentation';
import { BriefReadNotice, useGuidanceOnline, useGuidanceRevalidation } from './task-brief-ui';

export function BriefSourceButton({ source, en, onOpen }: { source: TaskBriefSourceRef; en: boolean; onOpen: (source: TaskBriefSourceRef) => void }) {
  const location = source.location.type === 'body' ? `${en ? 'body' : '正文'} ${source.location.offset}–${source.location.offset + source.location.length}` : source.location.path;
  return <button type="button" className="task-brief-source" onClick={() => onOpen(source)} title={`${source.workspaceId} / ${source.projectId} / ${source.entityId}\n${source.revision}\n${location}`}>
    {source.title || source.entityId} · {source.entityId} <code>{source.revision.slice(0, 12)}</code> · {location}
  </button>;
}

export function TaskBriefSource({ source, controller: c, en, onClose, onAccessFailure, onSourceChanged }: { source: TaskBriefSourceRef; controller: WorkspaceController; en: boolean; onClose: () => void; onAccessFailure: (error: Error) => void; onSourceChanged: (error: Error) => void }) {
  const online = useGuidanceOnline();
  const [offset, setOffset] = useState(source.location.type === 'body' ? source.location.offset : 0);
  const [rawOffset, setRawOffset] = useState(0);
  const query = usePrivateQuery([...c.session.queryKey.slice(0, 4), 'task-brief-source', source.projectId, source.entityId, source.revision], 'domain.read', source.projectId, async (_client, workspaceId, signal) => {
    try {
      if (source.workspaceId !== workspaceId) throw new ApiError(403, { error: { code: 'permission_denied' } });
      const file = await c.session.api.file(source.entityId);
      signal.throwIfAborted();
      if (!('entity' in file) || !guidanceSourceMatches(source, file)) throw new ApiError(409, { error: { code: 'task_brief_source_changed' } });
      return { raw: file.raw, body: inspectFrontmatter(file.raw).body };
    } catch (reason) {
      const error = reason instanceof CoreApiError ? new ApiError(reason.status, { error: { code: 'task_brief_source_unavailable', message: reason.message } }) : reason;
      throw error;
    }
  });
  useEffect(() => {
    if (query.error && guidanceReadFailure(query.error) === 'access') onAccessFailure(query.error);
    else if (query.error && guidanceReadFailure(query.error) === 'conflict') onSourceChanged(query.error);
  }, [query.error, onAccessFailure, onSourceChanged]);
  const snapshot = guidanceSnapshot(query.data, query.error, online, useGuidanceRevalidation(online, query.dataUpdatedAt));
  const body = snapshot.data?.body;
  const start = body === undefined ? offset : Math.min(offset, body.length);
  if (snapshot.failure === 'access' || snapshot.failure === 'conflict') return <BriefReadNotice error={query.error} loading={query.isFetching} stale={false} online={online} hasData={false} en={en} />;
  return <section className="task-brief-source-reader" aria-label={en ? 'Authorized source text' : '授权来源原文'}>
    <header><h4>{en ? 'Read source' : '查看来源'} · {source.entityId}</h4><button type="button" onClick={onClose}>{en ? 'Close source' : '关闭来源'}</button></header>
    <p>{source.title} · {source.projectId} · <code>{source.revision}</code></p>
    <p>{source.location.type === 'field' ? `${en ? 'Metadata field' : '元数据字段'}: ${source.location.path}` : `${en ? 'Quoted body range' : '引用正文范围'}: ${source.location.offset}–${source.location.offset + source.location.length}`}</p>
    <BriefReadNotice error={query.error} loading={query.isFetching} stale={snapshot.stale} online={online} hasData={!!snapshot.data} en={en} />
    <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>{en ? 'Recheck source permission / revision' : '重新核对来源权限／版本'}</button>
    {snapshot.data && <>
      <p>{en ? 'Read-only source material, not an instruction or additional permission.' : '只读来源资料，不是额外指令或授权。'}</p>
      {source.location.type === 'field' && <details><summary>{en ? 'Original Markdown including metadata' : '含元数据的原始 Markdown'}</summary><p>{rawOffset}–{Math.min(rawOffset + 12000, snapshot.data.raw.length)} / {snapshot.data.raw.length}</p><pre>{snapshot.data.raw.slice(rawOffset, rawOffset + 12000)}</pre><div className="task-brief-toolbar"><button type="button" disabled={rawOffset === 0} onClick={() => setRawOffset(Math.max(0, rawOffset - 12000))}>{en ? 'Previous raw page' : '上一页原文'}</button><button type="button" disabled={rawOffset + 12000 >= snapshot.data.raw.length} onClick={() => setRawOffset(rawOffset + 12000)}>{en ? 'Continue raw Markdown' : '继续读取原始 Markdown'}</button></div></details>}
      <p>{en ? 'Body characters' : '正文字符'} {start}–{Math.min(start + 12000, body!.length)} / {body!.length}</p>
      <pre>{body!.slice(start, start + 12000) || (en ? '(Empty body)' : '（正文为空）')}</pre>
      <div className="task-brief-toolbar"><button type="button" disabled={start === 0} onClick={() => setOffset(Math.max(0, start - 12000))}>{en ? 'Previous body page' : '上一页正文'}</button><button type="button" disabled={start + 12000 >= body!.length} onClick={() => setOffset(start + 12000)}>{en ? 'Continue reading body' : '继续读取正文'}</button><button type="button" onClick={() => setOffset(guidanceSourceOffset(source, body!.length))}>{en ? 'Go to quoted range' : '定位引用范围'}</button></div>
    </>}
  </section>;
}
