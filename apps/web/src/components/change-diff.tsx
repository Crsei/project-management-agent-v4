import { MultiFileDiff } from '@pierre/diffs/react';
import { Component, type ReactNode } from 'react';

class DiffBoundary extends Component<{ children: ReactNode; en: boolean }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="alert">{this.props.en ? 'The difference could not be rendered.' : '无法显示差异。'}</p> : this.props.children; }
}

/** Renders supplied immutable endpoints; missing endpoints must be handled by the caller. */
export function ChangeDiff({ before, after, name, en }: { before: string; after: string; name: string; en: boolean }) {
  if (before === after) return <p>{en ? 'No text changes.' : '正文没有变化。'}</p>;
  return <div style={{ overflow: 'auto', maxWidth: '100%' }}><DiffBoundary en={en}><MultiFileDiff oldFile={{ name, contents: before }} newFile={{ name, contents: after }} disableWorkerPool options={{ themeType: 'system', diffStyle: 'unified', overflow: 'scroll' }} /></DiffBoundary></div>;
}
