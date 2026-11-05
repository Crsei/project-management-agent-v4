import { useEffect, useId, useRef } from 'react';
import { AlertTriangle, ChevronDown, FileText, LoaderCircle, X } from 'lucide-react';
import type { FileRecord } from '@pm-schema';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../../components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../../components/ui/dialog';
import { documentTargetKey, type DocumentTarget, type DocumentTabStatus, type DocumentWorkbenchLifecycle } from './document-workbench-state';
import './document-tabs.css';

export interface DocumentTabsProps {
  tabs: readonly DocumentTarget[];
  active: DocumentTarget | null;
  files: readonly FileRecord[];
  en: boolean;
  statuses?: Readonly<Record<string, DocumentTabStatus>>;
  authorizedExternalKeys?: ReadonlySet<string>;
  onActivate(target: DocumentTarget): void;
  onClose(target: DocumentTarget): void;
  panelId?: string;
}
export function DocumentTabs({ tabs, active, files, en, statuses, authorizedExternalKeys, onActivate, onClose, panelId }: DocumentTabsProps) {
  const prefix = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterClose = useRef<string | null>(null);
  const activeKey = active && documentTargetKey(active);
  const label = (target: DocumentTarget) => target.kind === 'native'
    ? files.find(file => file.id === target.id && file.entity.entity === 'document')?.entity.title || target.id
    : authorizedExternalKeys?.has(documentTargetKey(target)) ? target.path : en ? 'External document' : '外部文档';
  const statusLabel = (target: DocumentTarget) => {
    const status = statuses?.[documentTargetKey(target)];
    return status?.saving ? (en ? 'Saving' : '保存中') : status?.unknown ? (en ? 'Unknown operation result' : '操作结果未知') : status?.error ? (en ? 'Save needs attention' : '保存需要处理') : status?.dirty ? (en ? 'Unsaved changes' : '未保存更改') : target.kind === 'external' ? (en ? 'External documents' : '外部文档') : '';
  };
  useEffect(() => { if (activeKey) buttons.current.get(activeKey)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [activeKey]);
  useEffect(() => {
    if (focusAfterClose.current && !tabs.some(target => documentTargetKey(target) === focusAfterClose.current)) {
      if (activeKey) buttons.current.get(activeKey)?.focus();
      focusAfterClose.current = null;
    }
  }, [activeKey, tabs]);
  return <div className="document-tabs-bar">
    <div className="document-tabs-scroll" role="tablist" aria-label={en ? 'Open documents' : '已打开的文档'} onKeyDown={event => {
      const element = event.target as HTMLElement;
      if (element.getAttribute('role') !== 'tab') return;
      const index = tabs.findIndex(target => buttons.current.get(documentTargetKey(target)) === element);
      if (index < 0) return;
      if (event.key === 'Delete') { event.preventDefault(); focusAfterClose.current = documentTargetKey(tabs[index]); onClose(tabs[index]); return; }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      const target = tabs[next];
      buttons.current.get(documentTargetKey(target))?.focus();
      onActivate(target);
    }}>
      {tabs.map((target, index) => {
        const key = documentTargetKey(target);
        const status = statuses?.[key];
        const selected = key === activeKey;
        const name = label(target);
        const description = statusLabel(target);
        return <ContextMenu key={key}><ContextMenuTrigger asChild><div className={`document-tab ${selected ? 'is-active' : ''}`} tabIndex={-1}>
          <button type="button" id={`${prefix}-tab-${index}`} ref={button => { if (button) buttons.current.set(key, button); else buttons.current.delete(key); }} role="tab" tabIndex={selected || !activeKey && index === 0 ? 0 : -1} aria-selected={selected} aria-controls={panelId} aria-label={`${name}${description ? ` · ${description}` : ''}`} title={`${name}${description ? ` · ${description}` : ''}`} onClick={() => onActivate(target)}>
            {status?.saving ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : status?.unknown || status?.error ? <AlertTriangle size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
            <span className="document-tab-label">{name}</span>{status?.dirty && <span className="document-tab-dirty" aria-hidden="true">●</span>}
          </button>
          <button type="button" className="document-tab-close" aria-label={en ? `Close ${name}` : `关闭 ${name}`} title={en ? 'Close document · Delete on tab' : '关闭文档 · 标签上按 Delete'} onClick={() => { focusAfterClose.current = key; onClose(target); }}><X size={13} /></button>
        </div></ContextMenuTrigger><ContextMenuContent aria-label={name}>
          <ContextMenuItem onSelect={() => onActivate(target)}>{en ? 'Activate document' : '切换到此文档'}</ContextMenuItem>
          <ContextMenuItem onSelect={() => { focusAfterClose.current = key; onClose(target); }}>{en ? 'Close document' : '关闭此文档'}</ContextMenuItem>
        </ContextMenuContent></ContextMenu>;
      })}
    </div>
    {tabs.length > 0 && <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="document-tabs-overflow" aria-label={en ? 'List all open documents' : '列出全部已打开文档'} title={en ? 'All open documents' : '全部已打开文档'}><ChevronDown size={16} /></button></DropdownMenuTrigger><DropdownMenuContent align="end" className="document-tabs-menu">{tabs.map(target => <DropdownMenuItem key={documentTargetKey(target)} onSelect={() => onActivate(target)}><span className="document-tab-label">{label(target)}</span>{documentTargetKey(target) === activeKey && <span aria-hidden="true">✓</span>}<small>{statusLabel(target)}</small></DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>}
  </div>;
}

export function DocumentCloseDialog({ lifecycle, en }: { lifecycle: DocumentWorkbenchLifecycle; en: boolean }) {
  const prompt = lifecycle.closePrompt;
  return <>
    {lifecycle.recovery.length > 0 && <div className="document-recovery-notices" aria-label={en ? 'Document save recovery' : '文档保存恢复'}>{lifecycle.recovery.map(item => <div key={item.id} className="document-recovery-notice" role={item.saving ? 'status' : 'alert'}><strong>{item.id}</strong><span>{item.saving ? (en ? 'Saving or reading the authoritative document…' : '正在保存或读取权威文档…') : item.message}</span>{!item.saving && <div><button type="button" className="text-button" onClick={() => void lifecycle.reconcile(item.id)}>{en ? 'Read authoritative source' : '读取权威源核对'}</button>{item.phase === 'observed' && <button type="button" className="text-button" onClick={() => lifecycle.adopt(item.id)}>{en ? 'Adopt observed revision; retain local edits' : '采用已核对版本并保留本地修改'}</button>}</div>}</div>)}</div>}
    <Dialog open={!!prompt} onOpenChange={open => { if (!open && !prompt?.busy) void lifecycle.resolveClose('cancel'); }}><DialogContent className="document-close-dialog"><DialogTitle>{en ? 'Close unsaved document?' : '关闭未保存的文档？'}</DialogTitle><DialogDescription>{en ? 'Save and close only after confirmation, keep the scoped local draft for reopening, or cancel. No choice silently discards your changes.' : '可在确认保存后关闭、保留当前账号与工作区的本地草稿以便重开，或取消。不会静默放弃修改。'}</DialogDescription>{prompt?.error && <p role="alert" className="document-close-error">{prompt.error}</p>}<div className="document-close-actions"><button type="button" className="secondary-button" disabled={prompt?.busy} onClick={() => void lifecycle.resolveClose('cancel')}>{en ? 'Cancel' : '取消'}</button><button type="button" className="secondary-button" disabled={prompt?.busy} onClick={() => void lifecycle.resolveClose('keep')}>{en ? 'Keep draft and close' : '保留草稿并关闭'}</button><button type="button" className="save-button" disabled={prompt?.busy} onClick={() => void lifecycle.resolveClose('save')}>{prompt?.busy && <LoaderCircle size={14} className="spin" />}{en ? 'Save and close' : '保存并关闭'}</button></div></DialogContent></Dialog>
  </>;
}
