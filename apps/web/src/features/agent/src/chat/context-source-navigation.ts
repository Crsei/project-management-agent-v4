type SourceTarget = { threadId: string; messageId: string; requestId: string; generationId?: string; itemId?: string };
let target: SourceTarget | null = null;
const listeners = new Set<() => void>();
export function requestContextSource(threadId: string, messageId: string, native?: { generationId: string; itemId: string }) { target = { threadId, messageId, requestId: crypto.randomUUID(), ...native }; for (const listener of listeners) listener(); }
export function subscribeContextSource(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function getContextSourceTarget() { return target; }
export function consumeContextSource(requestId: string) { if (target?.requestId === requestId) { target = null; for (const listener of listeners) listener(); } }
export function nativeContextSourceAnchor(generationId: string, itemId: string) { return `native-output-${encodeURIComponent(generationId)}-${encodeURIComponent(itemId)}`; }
