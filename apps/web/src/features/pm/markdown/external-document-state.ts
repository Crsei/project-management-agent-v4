import { documentSourceIdSchema, type DocumentSource, type DocumentSourceContent, type DocumentSourceMutation, type DocumentSourceMutationReceipt } from '../../../../../../packages/contracts/src/document-sources.ts';
import { documentSourceAccessLost, DocumentSourceRequestError } from './document-sources-api.ts';

export type ExternalTarget = { kind: 'external'; sourceId: string; revision: number; path: string };
export type ExternalManagementIntent = { action: 'create'; sourceId: string } | { action: 'rename' | 'move' | 'delete'; target: ExternalTarget };
export const externalDocumentKey = (target: ExternalTarget) => JSON.stringify(['external', target.sourceId, target.revision, target.path]);
/** One-time boundary migration; runtime targets only carry sourceId. */
export function restoreExternalDocumentTarget(value: unknown): ExternalTarget | undefined {
  if (!value || typeof value !== 'object') return;
  const item = value as Record<string, unknown>;
  if (item.sourceId !== undefined && item.scope !== undefined && item.sourceId !== item.scope) return;
  const identity = documentSourceIdSchema.safeParse(item.sourceId ?? item.scope);
  if (item.kind !== 'external' || !identity.success || typeof item.revision !== 'number' || !Number.isSafeInteger(item.revision) || item.revision <= 0 || typeof item.path !== 'string' || !validExternalMarkdownPath(item.path)) return;
  return { kind: 'external', sourceId: identity.data, revision: item.revision, path: item.path };
}
export type ExternalDraft = { target: ExternalTarget; source: DocumentSource; base: DocumentSourceContent; value: string; observed?: DocumentSourceContent | undefined };
export type ExternalOperationIdentity = { sourceId: string; operationId: string; action: DocumentSourceMutation['action']; targetSourceId?: string };
export type ExternalOperation = ExternalOperationIdentity & { phase: 'pending' | 'unknown'; input?: DocumentSourceMutation; error?: unknown };
export type ExternalCompletion = { sourceId: string; input?: DocumentSourceMutation; receipt: DocumentSourceMutationReceipt };
export type ExternalFormDraft = { sourceId: string; path: string; content: string; intent?: ExternalManagementIntent };
export type ExternalSnapshot = { drafts: Record<string, ExternalDraft>; operations: ExternalOperation[]; completions: ExternalCompletion[]; forms: Record<string, ExternalFormDraft>; notice: string; version: number };
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
type Dependencies = { storage: Storage; storageKey: string; mutate(sourceId: string, input: DocumentSourceMutation): Promise<DocumentSourceMutationReceipt>; reconcile(sourceId: string, operationId: string): Promise<DocumentSourceMutationReceipt>; current(): boolean };
export interface ExternalDocumentStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ExternalSnapshot;
  blocks(sourceId: string): boolean;
  protected(): boolean;
  clearSource(sourceId?: string): void;
  authorize(sources: readonly DocumentSource[]): void;
  receive(target: ExternalTarget, source: DocumentSource, content: DocumentSourceContent): void;
  edit(target: ExternalTarget, value: string): void;
  adopt(target: ExternalTarget): void;
  discard(target: ExternalTarget): void;
  form(key: string, value?: ExternalFormDraft): void;
  acknowledge(): void;
  submit(sourceId: string, input: DocumentSourceMutation): Promise<DocumentSourceMutationReceipt | undefined>;
  reconcile(operationId: string): Promise<void>;
}

/** Only opaque operation identities enter persistence; never a path, body, or frozen payload. */
export function restoreExternalOperationIdentities(value: unknown): ExternalOperationIdentity[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    if (item.sourceId !== undefined && item.scope !== undefined && item.sourceId !== item.scope || item.targetSourceId !== undefined && item.targetScope !== undefined && item.targetSourceId !== item.targetScope) return [];
    // Old IDs already are the migrated source IDs. Recovery queries the original
    // operation without recreating its request, changing its proof, or replaying it.
    const sourceId = item.sourceId ?? item.scope;
    const targetSourceId = item.targetSourceId ?? item.targetScope;
    if (!documentSourceIdSchema.safeParse(sourceId).success || targetSourceId !== undefined && !documentSourceIdSchema.safeParse(targetSourceId).success || typeof item.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.operationId) || !['create', 'save', 'move', 'delete'].includes(item.action) || seen.has(item.operationId)) return [];
    seen.add(item.operationId);
    return [{ sourceId, operationId: item.operationId, action: item.action, ...(targetSourceId !== undefined ? { targetSourceId } : {}) }];
  });
}
export function validExternalMarkdownPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !/[\\\x00-\x1f\x7f:]/.test(path) && !path.startsWith('/') && /\.md$/i.test(path) && path.split('/').every(part => !!part && part !== '.' && part !== '..');
}
export function createExternalDocumentStore(deps: Dependencies): ExternalDocumentStore {
  const listeners = new Set<() => void>();
  const readJournal = () => {
    const raw: unknown = JSON.parse(deps.storage.getItem(deps.storageKey) || '[]');
    const identities = restoreExternalOperationIdentities(raw);
    if (!Array.isArray(raw) || raw.length !== identities.length) throw new Error('journal_unavailable');
    return identities;
  };
  let initial: ExternalOperationIdentity[] = [];
  let journalUnavailable = false;
  try {
    const raw: unknown = JSON.parse(deps.storage.getItem(deps.storageKey) || '[]');
    initial = restoreExternalOperationIdentities(raw);
    journalUnavailable = !Array.isArray(raw) || raw.length !== initial.length;
    if (!journalUnavailable && JSON.stringify(raw) !== JSON.stringify(initial)) deps.storage.setItem(deps.storageKey, JSON.stringify(initial));
  } catch { journalUnavailable = true; }
  let snapshot: ExternalSnapshot = { drafts: {}, operations: initial.map(item => ({ ...item, phase: 'unknown' })), completions: [], forms: {}, notice: journalUnavailable ? 'journal_unavailable' : '', version: 0 };
  let authorizedSources: Map<string, DocumentSource> | undefined;
  const update = (change: Partial<ExternalSnapshot>) => { snapshot = { ...snapshot, ...change, version: snapshot.version + 1 }; listeners.forEach(listener => listener()); };
  const journal = (add?: ExternalOperationIdentity, remove?: string) => {
    const entries = new Map(readJournal().map(item => [item.operationId, item]));
    if (remove) entries.delete(remove);
    if (add) entries.set(add.operationId, { sourceId: add.sourceId, operationId: add.operationId, action: add.action, ...(add.targetSourceId ? { targetSourceId: add.targetSourceId } : {}) });
    deps.storage.setItem(deps.storageKey, JSON.stringify([...entries.values()]));
    journalUnavailable = false;
  };
  // Alias paths are not exposed to every reader. Until a receipt settles, block
  // every source in this workspace rather than guessing which roots overlap.
  const blocks = (_sourceId: string) => journalUnavailable || snapshot.operations.length > 0;
  const clearSource = (sourceId?: string) => {
    authorizedSources ??= new Map();
    if (sourceId === undefined) authorizedSources.clear();
    else authorizedSources.delete(sourceId);
    const clearsForm = (form: ExternalFormDraft) => sourceId === undefined || form.sourceId === sourceId || form.intent && form.intent.action !== 'create' && form.intent.target.sourceId === sourceId;
    const cleared = Object.values(snapshot.drafts).some(draft => sourceId === undefined || draft.target.sourceId === sourceId) || Object.values(snapshot.forms).some(clearsForm);
    update({ drafts: Object.fromEntries(Object.entries(snapshot.drafts).filter(([, draft]) => sourceId !== undefined && draft.target.sourceId !== sourceId)), forms: Object.fromEntries(Object.entries(snapshot.forms).filter(([, form]) => !clearsForm(form))), operations: snapshot.operations.map(item => sourceId === undefined || item.sourceId === sourceId || item.targetSourceId === sourceId ? { sourceId: item.sourceId, operationId: item.operationId, action: item.action, ...(item.targetSourceId ? { targetSourceId: item.targetSourceId } : {}), phase: item.phase } : item), completions: [], ...(cleared ? { notice: 'access_cleared' } : {}) });
  };
  const settle = (operation: ExternalOperation, receipt: DocumentSourceMutationReceipt) => {
    if (!deps.current()) { clearSource(); return; }
    operation = snapshot.operations.find(item => item.operationId === operation.operationId) || { ...operation, input: undefined };
    if (receipt.operationId !== operation.operationId || receipt.action !== operation.action || operation.input && receipt.path !== operation.input.path) throw new Error('invalid_response');
    if (receipt.status === 'unknown') { update({ operations: snapshot.operations.map(item => item.operationId === operation.operationId ? { ...operation, phase: 'unknown' } : item) }); return; }
    if (receipt.status === 'succeeded' && receipt.action === 'move' && operation.targetSourceId && receipt.targetSourceId !== operation.targetSourceId) throw new Error('invalid_response');
    if (receipt.status === 'succeeded' && receipt.content) {
      const moving = receipt.action === 'move';
      if (receipt.content.path !== (moving ? receipt.targetPath : receipt.path) || moving && !receipt.targetSourceId) throw new Error('invalid_response');
      if (operation.input && (moving && operation.input.action === 'move' ? receipt.targetSourceId !== operation.input.targetSourceId || receipt.targetPath !== operation.input.targetPath || receipt.content.sourceRevision !== operation.input.targetSourceRevision : receipt.content.sourceRevision !== operation.input.sourceRevision)) throw new Error('invalid_response');
    }
    if (receipt.content && authorizedSources) {
      const source = authorizedSources.get(receipt.targetSourceId || operation.sourceId);
      if (!source || source.status !== 'available' || source.revision !== receipt.content.sourceRevision) receipt = { ...receipt, content: undefined };
    }
    // Keep the entry if removing its recovery identity failed. Re-querying is harmless.
    journal(undefined, operation.operationId);
    const unreadableSuccess = receipt.status === 'succeeded' && receipt.action !== 'delete' && !receipt.content;
    if (unreadableSuccess) { clearSource(operation.sourceId); if (receipt.targetSourceId) clearSource(receipt.targetSourceId); }
    const drafts = { ...snapshot.drafts };
    if (receipt.status === 'succeeded') {
      const original = Object.entries(drafts).find(([, draft]) => draft.target.sourceId === operation.sourceId && draft.target.path === receipt.path && (!operation.input || draft.target.revision === operation.input.sourceRevision));
      if (original) {
        const [key, draft] = original;
        if (receipt.action === 'delete' || receipt.action === 'move') delete drafts[key];
        if ((receipt.action === 'save' || receipt.action === 'create') && receipt.content) drafts[key] = { ...draft, base: receipt.content, value: draft.value === (operation.input && 'content' in operation.input ? operation.input.content : draft.value) ? receipt.content.content : draft.value, observed: undefined };
        if (receipt.action === 'move' && receipt.content && receipt.targetSourceId && receipt.targetPath) {
          const target: ExternalTarget = { kind: 'external', sourceId: receipt.targetSourceId, revision: receipt.content.sourceRevision, path: receipt.targetPath };
          const source = authorizedSources?.get(target.sourceId);
          drafts[externalDocumentKey(target)] = { ...draft, ...(source ? { source } : {}), target, base: receipt.content, value: draft.value, observed: undefined };
        }
      }
    }
    update({ drafts, operations: snapshot.operations.filter(item => item.operationId !== operation.operationId), completions: [...snapshot.completions, { sourceId: operation.sourceId, ...(operation.input && !unreadableSuccess ? { input: operation.input } : {}), receipt }], notice: receipt.status === 'not_applied' ? 'not_applied' : unreadableSuccess ? 'succeeded_unreadable' : 'succeeded' });
  };
  const fail = (operation: ExternalOperation, error: unknown) => {
    if (!deps.current()) { clearSource(); return; }
    if (documentSourceAccessLost(error)) clearSource(operation.sourceId);
    update({ operations: snapshot.operations.map(item => item.operationId === operation.operationId ? { ...item, phase: 'unknown', error } : item) });
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    blocks,
    protected: () => journalUnavailable || Object.values(snapshot.drafts).some(draft => draft.value !== draft.base.content) || Object.values(snapshot.forms).some(form => !!form.content || !!form.path) || snapshot.operations.length > 0,
    clearSource,
    authorize(sources: readonly DocumentSource[]) {
      const scopes = new Set([...Object.values(snapshot.forms).flatMap(form => form.intent && form.intent.action !== 'create' ? [form.sourceId, form.intent.target.sourceId] : [form.sourceId]), ...snapshot.operations.flatMap(operation => operation.targetSourceId ? [operation.sourceId, operation.targetSourceId] : [operation.sourceId])]);
      const revoked = new Set([...scopes].filter(sourceId => !sources.some(source => source.sourceId === sourceId && source.status === 'available')));
      for (const draft of Object.values(snapshot.drafts)) if (!sources.some(source => source.sourceId === draft.target.sourceId && source.revision === draft.target.revision && source.status === 'available')) revoked.add(draft.target.sourceId);
      for (const sourceId of revoked) clearSource(sourceId);
      if (revoked.size) update({ notice: 'access_cleared' });
      const drafts = Object.fromEntries(Object.entries(snapshot.drafts).map(([key, draft]) => {
        const source = sources.find(item => item.sourceId === draft.target.sourceId)!;
        return [key, { ...draft, source }];
      }));
      if (Object.keys(drafts).length) update({ drafts });
      authorizedSources = new Map(sources.filter(source => source.status === 'available').map(source => [source.sourceId, source]));
    },
    receive(target: ExternalTarget, source: DocumentSource, content: DocumentSourceContent) {
      if (!deps.current()) return;
      if (source.sourceId !== target.sourceId || source.revision !== target.revision || content.sourceRevision !== target.revision || content.path !== target.path) throw new Error('invalid_response');
      authorizedSources?.set(source.sourceId, source);
      const key = externalDocumentKey(target), previous = snapshot.drafts[key];
      const dirty = previous && previous.value !== previous.base.content;
      const draft: ExternalDraft = dirty ? { ...previous, source, ...(content.revision !== previous.base.revision ? { observed: content } : { observed: undefined }) } : { target, source, base: content, value: content.content };
      update({ drafts: { ...snapshot.drafts, [key]: draft } });
    },
    edit(target: ExternalTarget, value: string) { const key = externalDocumentKey(target), draft = snapshot.drafts[key]; if (draft) update({ drafts: { ...snapshot.drafts, [key]: { ...draft, value } } }); },
    adopt(target: ExternalTarget) { const key = externalDocumentKey(target), draft = snapshot.drafts[key]; if (draft?.observed) update({ drafts: { ...snapshot.drafts, [key]: { ...draft, base: draft.observed, observed: undefined } } }); },
    discard(target: ExternalTarget) { const drafts = { ...snapshot.drafts }; delete drafts[externalDocumentKey(target)]; update({ drafts }); },
    form(key: string, value?: ExternalFormDraft) { const forms = { ...snapshot.forms }; if (value) forms[key] = value; else delete forms[key]; update({ forms }); },
    acknowledge() { if (snapshot.completions.length) update({ completions: [] }); },
    async submit(sourceId: string, input: DocumentSourceMutation) {
      if (journalUnavailable) throw new Error('journal_unavailable');
      if (!deps.current() || blocks(sourceId) || input.action === 'move' && blocks(input.targetSourceId)) throw new Error('operation_pending');
      if (input.action === 'move') {
        const destination = snapshot.drafts[externalDocumentKey({ kind: 'external', sourceId: input.targetSourceId, revision: input.targetSourceRevision, path: input.targetPath })];
        if (destination && destination.value !== destination.base.content) throw new DocumentSourceRequestError(409, 'document_source_destination_draft_conflict');
      }
      const operation: ExternalOperation = { sourceId, operationId: input.operationId, action: input.action, ...(input.action === 'move' ? { targetSourceId: input.targetSourceId } : {}), input, phase: 'pending' };
      // If this fails, no network mutation is issued.
      try { journal(operation); } catch { update({ notice: 'journal_unavailable' }); throw new Error('journal_unavailable'); }
      update({ operations: [...snapshot.operations, operation], notice: '' });
      try { const receipt = await deps.mutate(sourceId, input); settle(operation, receipt); return receipt; }
      catch (error) {
        // The API promises ordinary 4xx errors occur before dispatch. ID conflicts
        // are different: an existing operation may already have had effects.
        if (error instanceof DocumentSourceRequestError && error.status >= 400 && error.status < 500 && error.code !== 'document_source_operation_id_conflict') {
          try { journal(undefined, operation.operationId); } catch { fail(operation, error); throw error; }
          update({ operations: snapshot.operations.filter(item => item.operationId !== operation.operationId) });
          if (documentSourceAccessLost(error)) clearSource(sourceId);
        } else fail(operation, error);
        throw error;
      }
    },
    async reconcile(operationId: string) {
      const operation = snapshot.operations.find(item => item.operationId === operationId);
      if (!operation || operation.phase === 'pending') return;
      update({ operations: snapshot.operations.map(item => item === operation ? { ...item, phase: 'pending' } : item) });
      try { settle(operation, await deps.reconcile(operation.sourceId, operationId)); } catch (error) { fail(operation, error); }
    },
  };
}
