import type { DocumentTarget } from './document-workbench-state';
import { safeWorkspaceReturn } from './task-collection-model.ts';
import { restoreExternalDocumentTarget } from './external-document-state.ts';

const targetParams = ['document', 'externalSourceId', 'externalScope', 'externalRevision', 'externalPath'] as const;

/** The URL selects the editor; remembered tabs never override a deep link or history. */
export function documentWorkbenchLocation(params: URLSearchParams): { enabled: boolean; target: DocumentTarget | null; invalid: boolean } {
  const enabled = params.get('workbench') === '1' || targetParams.some(key => params.has(key));
  if (!enabled) return { enabled: false, target: null, invalid: false };
  const native = params.get('document');
  const external = ['externalSourceId', 'externalScope', 'externalRevision', 'externalPath'].some(key => params.has(key));
  if (native && !external && !/[\u0000-\u001f]/.test(native)) return { enabled: true, target: { kind: 'native', id: native }, invalid: false };
  if (!params.has('document') && external) {
    const sourceId = params.get('externalSourceId') ?? params.get('externalScope');
    const revision = params.get('externalRevision');
    const path = params.get('externalPath');
    const target = revision && /^\d+$/.test(revision) ? restoreExternalDocumentTarget({ kind: 'external', sourceId, revision: Number(revision), path }) : undefined;
    if (target && !(params.has('externalSourceId') && params.has('externalScope') && params.get('externalScope') !== sourceId)) return { enabled: true, target, invalid: false };
  }
  return { enabled: true, target: null, invalid: params.has('document') || external };
}

/** A return URL can leave the workbench, but cannot leave the current workspace. */
export function documentWorkbenchReturn(value: string | null | undefined, root: string, fallback = `${root}/documents`): string {
  const back = safeWorkspaceReturn(value, root, fallback);
  const url = new URL(back, 'https://workspace.invalid');
  if (documentWorkbenchLocation(url.searchParams).enabled || /\/entities\/[^/]+\/?$/.test(url.pathname) || /\/issues\/new\/?$/.test(url.pathname)) return fallback;
  return back;
}

export function documentWorkbenchUrl(root: string, target: DocumentTarget | null, returnTo?: string, anchor?: string): string {
  const params = new URLSearchParams({ workbench: '1' });
  if (target?.kind === 'native') params.set('document', target.id);
  else if (target?.kind === 'external') {
    params.set('externalSourceId', target.sourceId);
    params.set('externalRevision', String(target.revision));
    params.set('externalPath', target.path);
  }
  if (returnTo) params.set('returnTo', documentWorkbenchReturn(returnTo, root));
  return `${root}/documents?${params}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`;
}
