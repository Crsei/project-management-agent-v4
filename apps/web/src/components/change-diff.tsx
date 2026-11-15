import { PatchDiff, type FileDiffOptions } from '@pierre/diffs/react';
import { createTwoFilesPatch } from 'diff';
import { Component, useMemo, useState, type ReactNode } from 'react';

class DiffBoundary extends Component<{ children: ReactNode; fallback: ReactNode; patch: string }, { failed: boolean; patch: string }> {
  state = { failed: false, patch: this.props.patch };
  static getDerivedStateFromProps(props: { patch: string }, state: { patch: string }) {
    return props.patch !== state.patch ? { failed: false, patch: props.patch } : null;
  }
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function SourceEndpoints({ before, after, en }: { before: string; after: string; en: boolean }) {
  return <div>
    <p role="status">{en ? 'The source difference exceeds the display limit or could not be rendered. Both complete endpoints remain available below; no content has been truncated.' : '源码差异超出展示限制或无法渲染。可在下方查看两个完整端点，内容未截断。'}</p>
    {([{ label: en ? 'Before source' : '之前的源码', value: before }, { label: en ? 'After source' : '之后的源码', value: after }]).map(({ label, value }) => <details key={label}><summary>{label}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '60vh', overflow: 'auto' }}>{value}</pre></details>)}
  </div>;
}

/** Renders supplied immutable endpoints; missing endpoints must be handled by the caller. */
export function ChangeDiff({ before, after, name, en }: { before: string; after: string; name: string; en: boolean }) {
  const [layout, setLayout] = useState<'unified' | 'split'>('unified');
  const [wrap, setWrap] = useState(true);
  const patch = useMemo(() => {
    if (before === after || before.length + after.length > 512_000) return undefined;
    const filename = name.replace(/[\r\n\t]/g, ' ');
    try {
      return createTwoFilesPatch(filename, filename, before, after, undefined, undefined, { context: 3, timeout: 150, maxEditLength: 4000 });
    } catch { return undefined; }
  }, [before, after, name]);
  const options = useMemo<FileDiffOptions<undefined, undefined>>(() => ({
    themeType: 'system', diffStyle: layout, overflow: wrap ? 'wrap' : 'scroll',
    maxLineDiffLength: 2000, tokenizeMaxLineLength: 2000, tokenizeMaxLength: 50_000,
  }), [layout, wrap]);
  if (before === after) return <p>{en ? 'No text changes.' : '正文没有变化。'}</p>;
  const fallback = <SourceEndpoints before={before} after={after} en={en} />;
  if (!patch) return fallback;
  return <section aria-label={en ? 'Source difference' : '源码差异'} style={{ minWidth: 0, maxWidth: '100%' }}>
    <div className="flex flex-wrap items-center gap-2 py-2">
      <div role="group" aria-label={en ? 'Diff layout' : '差异布局'}>
        <button type="button" aria-pressed={layout === 'unified'} onClick={() => setLayout('unified')}>{en ? 'Unified' : '单栏'}</button>
        <button type="button" aria-pressed={layout === 'split'} onClick={() => setLayout('split')}>{en ? 'Side by side' : '左右对照'}</button>
      </div>
      <label><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)} /> {en ? 'Wrap lines' : '自动换行'}</label>
    </div>
    <div style={{ overflow: 'auto', maxWidth: '100%' }}><DiffBoundary patch={patch} fallback={fallback}><PatchDiff patch={patch} disableWorkerPool options={options} /></DiffBoundary></div>
  </section>;
}
