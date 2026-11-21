import { Component, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChangeDiff } from '../../../components/change-diff';
import { buildMarkdownDiff, type MarkdownChange, type MarkdownDiffModel } from './markdown-diff-model.ts';
import { HistoricalMarkdownBlock } from './markdown-diff-render.tsx';
import 'katex/dist/katex.min.css';
import './preview.css';
import './markdown-diff.css';

type Props = { before: string; after: string; name: string; en: boolean; presentation?: 'history' | 'inline'; onReady?: () => void };

function SourceFallback({ reason, ...props }: Props & { reason: string }) {
  return <div className="md-diff-fallback"><p role="status">{props.en ? `Rendered review unavailable (${reason}); showing the exact source difference instead.` : `正文差异无法安全显示（${reason}）；已改为显示完整源码差异。`}</p><ChangeDiff {...props} /></div>;
}

class MarkdownDiffBoundary extends Component<Props & { children: ReactNode }, { failed: boolean; before: string; after: string }> {
  state = { failed: false, before: this.props.before, after: this.props.after };
  static getDerivedStateFromError() { return { failed: true }; }
  static getDerivedStateFromProps(props: Props, state: { before: string; after: string }) {
    return props.before !== state.before || props.after !== state.after ? { failed: false, before: props.before, after: props.after } : null;
  }
  render() { return this.state.failed ? <SourceFallback {...this.props} reason={this.props.en ? 'unsupported rendering' : '不支持的渲染内容'} /> : this.props.children; }
}

function reasonLabel(reason: Extract<MarkdownDiffModel, { kind: 'fallback' }>['reason'], en: boolean): string {
  return ({ size: en ? 'document size limit' : '文档大小超出限制', structure: en ? 'block, nesting or rich-content limit' : '块数量、嵌套或富文本大小超出限制', complexity: en ? 'comparison work limit' : '比较运算超出限制', unsupported: en ? 'unsupported Markdown structure' : '不支持的 Markdown 结构' })[reason];
}

function ChangedBlock({ change, index, prefix, name, en, inline = false }: { change: MarkdownChange; index: number; prefix: string; name: string; en: boolean; inline?: boolean }) {
  const code = (change.before?.node?.type === 'code' || change.after?.node?.type === 'code') && ![change.before?.node?.lang, change.after?.node?.lang].some(language => ['mermaid', 'pm-view'].includes(language?.toLowerCase() ?? ''));
  return <section className={`md-diff-change md-diff-${change.kind}`} data-change-index={index} tabIndex={-1} aria-label={en ? `Change ${index + 1}` : `变更 ${index + 1}`}>
    {!inline && <header className="md-diff-change-heading"><strong>{en ? `Change ${index + 1}` : `变更 ${index + 1}`}</strong><span>{change.kind === 'added' ? (en ? 'Added' : '新增') : change.kind === 'removed' ? (en ? 'Removed' : '删除') : change.syntaxOnly ? (en ? 'Formatting, reference or source change' : '格式、引用或源码变更') : (en ? 'Modified' : '修改')}</span></header>}
    {code ? <ChangeDiff before={change.before?.source ?? ''} after={change.after?.source ?? ''} name={`${name}.block-${index + 1}.${change.after?.node?.lang || change.before?.node?.lang || 'txt'}`} en={en} /> : <div className="md-diff-sides">
      {(['before', 'after'] as const).map(side => {
        const block = change[side]; if (!block) return null;
        return <div className={`md-diff-side md-diff-${side === 'before' ? 'removed' : 'added'}`} key={side}><div className="md-diff-side-label">{side === 'before' ? (en ? '− Before' : '− 变更前') : (en ? '+ After' : '+ 变更后')}</div><div className="markdown-preview"><HistoricalMarkdownBlock block={block} ranges={side === 'before' ? change.beforeRanges : change.afterRanges} side={side} prefix={`${prefix}-${index}-${side}`} en={en} />{!block.source.trim() && <p className="md-diff-whitespace">{en ? 'Whitespace / blank lines' : '空白字符 / 空行'}</p>}</div></div>;
      })}
    </div>}
    {!inline && !code && <SourceDetails change={change} name={name} en={en} />}
  </section>;
}

function SourceDetails({ change, name, en }: { change: MarkdownChange; name: string; en: boolean }) {
  const [open, setOpen] = useState(false);
  return <details className="md-diff-source" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{en ? 'Exact source (including formatting and whitespace)' : '精确源码（包含格式与空白字符）'}</summary>{open && <><ChangeDiff before={change.before?.source ?? ''} after={change.after?.source ?? ''} name={name} en={en} />{change.before?.source === change.after?.source && <p>{en ? 'The reference definition changed elsewhere in this snapshot.' : '此快照中其他位置的引用定义发生了变化。'}</p>}</>}</details>;
}

type Group = { kind: 'equal'; changes: MarkdownChange[] } | { kind: 'changed'; change: MarkdownChange; index: number };
function Review({ model, name, en, inline = false }: { model: Extract<MarkdownDiffModel, { kind: 'rendered' }>; name: string; en: boolean; inline?: boolean }) {
  const root = useRef<HTMLDivElement>(null); const prefix = `md-history-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [selection, setSelection] = useState<{ model: typeof model; index: number }>({ model, index: -1 });
  const current = selection.model === model ? selection.index : -1;
  const [expanded, setExpanded] = useState(false);
  const groups = useMemo(() => {
    const result: Group[] = []; let index = 0;
    for (const change of model.changes) {
      if (change.kind !== 'equal') { result.push({ kind: 'changed', change, index: index++ }); continue; }
      const previous = result.at(-1);
      if (previous?.kind === 'equal') previous.changes.push(change); else result.push({ kind: 'equal', changes: [change] });
    }
    return result;
  }, [model]);
  function move(direction: number) {
    if (!model.count) return;
    const next = current < 0 ? (direction > 0 ? 0 : model.count - 1) : (current + direction + model.count) % model.count;
    setSelection({ model, index: next });
    const element = root.current?.querySelector<HTMLElement>(`[data-change-index="${next}"]`);
    element?.focus({ preventScroll: true }); element?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }
  if (inline) return <div className="md-diff is-inline" ref={root}>
    {!model.count && <p>{en ? 'No text changes.' : '正文没有变化。'}</p>}
    {groups.map((group, groupIndex) => group.kind === 'changed' ? <ChangedBlock key={groupIndex} change={group.change} index={group.index} prefix={prefix} name={name} en={en} inline /> : null)}
  </div>;
  return <div className="md-diff" ref={root}>
    <div className="md-diff-toolbar" role="group" aria-label={en ? 'Markdown review controls' : 'Markdown 审阅控制'}><span role="status" aria-live="polite">{en ? `${model.count} changes${current >= 0 ? ` · ${current + 1}/${model.count}` : ''}` : `${model.count} 处变更${current >= 0 ? ` · ${current + 1}/${model.count}` : ''}`}</span><button type="button" disabled={!model.count} onClick={() => move(-1)}>{en ? 'Previous change' : '上一处变更'}</button><button type="button" disabled={!model.count} onClick={() => move(1)}>{en ? 'Next change' : '下一处变更'}</button><button type="button" aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? (en ? 'Collapse unchanged' : '折叠未变更内容') : (en ? 'Expand unchanged' : '展开未变更内容')}</button></div>
    <p className="md-diff-history-note">{en ? 'Immutable snapshots. Tasks are read-only; embeds, images and attachments are historical references only. Source details retain every syntax change.' : '不可变历史快照。任务只读；嵌入、图片与附件仅显示历史引用。源码详情保留所有语法变化。'}</p>
    {!model.count && <p>{en ? 'No text changes.' : '正文没有变化。'}</p>}
    {groups.map((group, groupIndex) => group.kind === 'changed' ? <ChangedBlock key={groupIndex} change={group.change} index={group.index} prefix={prefix} name={name} en={en} /> : <UnchangedGroup key={`${groupIndex}-${expanded}`} changes={group.changes} expanded={expanded} prefix={`${prefix}-equal-${groupIndex}`} en={en} />)}
  </div>;
}

function UnchangedGroup({ changes, expanded, prefix, en }: { changes: MarkdownChange[]; expanded: boolean; prefix: string; en: boolean }) {
  const [open, setOpen] = useState(expanded);
  const visible = changes.filter(change => change.after?.node || change.after?.source.trim());
  if (!visible.length) return null;
  return <details className="md-diff-unchanged" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{en ? `${visible.length} unchanged blocks` : `${visible.length} 个未变更块`}</summary>{open && <div className="markdown-preview">{visible.map((change, index) => <HistoricalMarkdownBlock key={index} block={change.after!} prefix={`${prefix}-${index}`} en={en} />)}</div>}</details>;
}

/** Receives known, authorized endpoint bodies only; never loads or acknowledges history. */
export function MarkdownDiff(props: Props) {
  const { before, after, onReady, presentation } = props;
  const inline = presentation === 'inline';
  const model = useMemo(() => buildMarkdownDiff(before, after), [before, after]);
  useLayoutEffect(() => { onReady?.(); }, [before, after, onReady]);
  return <MarkdownDiffBoundary {...props}>{model.kind === 'fallback' ? <SourceFallback {...props} reason={reasonLabel(model.reason, props.en)} /> : <Review model={model} name={props.name} en={props.en} inline={inline} />}</MarkdownDiffBoundary>;
}
