import { FileText, Link2, ListTree, X } from 'lucide-react';
import { statusCategory, workflowFor, type FileRecord } from '@pm-schema';
import { StatusIcon } from '@pm-views';
import { headingSlug } from '@pm-markdown';
import type { WorkspaceController } from './controller';
import { scanDocumentOutline } from './document-structure';
import { AgentAssistantMenu } from '../agent/agent-assistant-menu';

type Props = {
  controller: WorkspaceController;
  en: boolean;
  onClose: () => void;
  onOutline: (slug: string) => void;
  onOpenEntity: (file: FileRecord) => void;
};

export function DocumentContextPanel({ controller: c, en, onClose, onOutline, onOpenEntity }: Props) {
  if (c.query.isPending) return <div className="document-context-empty" role="status">{en ? 'Loading document context…' : '正在加载文档上下文…'}</div>;
  const doc = c.entity?.entity === 'document' ? c.entity : undefined;
  if (!doc) return <div className="document-context-empty" role="status">{en ? 'Document context is unavailable.' : '文档上下文不可用。'}</div>;
  const outline = scanDocumentOutline(doc.body).filter(heading => heading.level > 1);
  const linkedTasks = c.files.filter(file => file.entity.entity === 'work_item' && (doc.related_to.includes(file.id) || doc.links.includes(file.id) || doc.blocked_by.includes(file.id) || file.entity.related_to.includes(doc.id) || file.entity.links.includes(doc.id) || file.entity.blocked_by.includes(doc.id)));
  const backlinks = c.files.filter(file => file.id !== doc.id && file.entity.entity !== 'work_item' && (file.entity.related_to.includes(doc.id) || file.entity.links.includes(doc.id) || file.entity.blocked_by.includes(doc.id)));
  const workflow = workflowFor('work_item', c.configuration);
  const statusLabel = (file: FileRecord) => workflow?.states.find(state => state.id === file.entity.status)?.label || file.entity.status || (en ? 'Status unavailable' : '状态不可用');
  return <div className="document-workbench-context-panel">
    <div className="document-workbench-context-heading"><div><ListTree size={15} /><strong>{en ? 'Document context' : '文档上下文'}</strong></div><button type="button" className="icon-button" aria-label={en ? 'Close document context' : '关闭文档上下文'} onClick={onClose}><X size={15} /></button></div>
    <div className="document-context-scroll">
      <details open className="document-context-section">
        <summary><ListTree size={14} /><span>{en ? 'Outline' : '大纲'}</span><small>{outline.length}</small></summary>
        {outline.length > 0 ? <ol className="document-context-outline">{outline.map(heading => <li key={heading.from}><button type="button" style={{ paddingInlineStart: `${8 + (heading.level - 1) * 10}px` }} onClick={() => onOutline(headingSlug(heading.title))}>{heading.title}</button></li>)}</ol> : <p>{en ? 'No Markdown headings yet.' : '还没有 Markdown 标题。'}</p>}
      </details>
      <details open className="document-context-section">
        <summary><Link2 size={14} /><span>{en ? 'Linked tasks' : '关联任务'}</span><small>{linkedTasks.length}</small></summary>
        {linkedTasks.length > 0 ? <ul className="document-context-links">{linkedTasks.map(file => <li key={file.id}><StatusIcon category={statusCategory(file.entity, c.configuration)} /><button type="button" onClick={() => onOpenEntity(file)}><strong>{file.entity.title}</strong><small><code>{file.id}</code> · {statusLabel(file)}{file.entity.archived ? en ? ' · Archived' : ' · 已归档' : ''}</small></button></li>)}</ul> : <p>{en ? 'No saved task links this document.' : '没有已保存任务关联此文档。'}</p>}
      </details>
      <details className="document-context-section">
        <summary><FileText size={14} /><span>{en ? 'Referenced by' : '引用这份文档'}</span><small>{backlinks.length}</small></summary>
        {backlinks.length > 0 ? <ul className="document-context-links">{backlinks.map(file => <li key={file.id}><FileText size={14} aria-hidden="true" /><button type="button" onClick={() => onOpenEntity(file)}><strong>{file.entity.title}</strong><small><code>{file.id}</code> · {file.entity.entity}{file.entity.archived ? en ? ' · Archived' : ' · 已归档' : ''}</small></button></li>)}</ul> : <p>{en ? 'No saved document or planning object references this document.' : '没有已保存文档或规划对象引用此文档。'}</p>}
      </details>
      <section className="document-context-section document-context-agent" aria-label={en ? 'Agent assistant' : 'Agent 助手'}>
        <div className="document-context-agent-heading"><strong>{en ? 'Agent assistant' : 'Agent 助手'}</strong></div>
        <p>{en ? 'Run a configured project automation or go to Agent Chat.' : '运行已配置的项目自动化，或前往 Agent Chat。'}</p>
        <AgentAssistantMenu projectId={doc.project} disabledReason={!c.canWrite || c.configurationInvalid || c.accessError || c.query.error || c.writesBlocked ? (en ? 'PM writes are currently locked; resolve access, configuration or the original pending request first.' : 'PM 当前为只读或写入已锁定；请先核对权限、配置或原待处理请求。') : undefined} />
      </section>
    </div>
  </div>;
}
