/** Cancel only this waiter; native cache/refresh work may belong to other callers. */
export async function waitForUsageRead<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) { void work.catch(() => {}); signal.throwIfAborted(); }
  const { promise, reject } = Promise.withResolvers<never>();
  const abort = () => reject(signal.reason ?? new DOMException("Usage read cancelled.", "AbortError"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try { return await Promise.race([work, promise]); }
  finally { signal.removeEventListener("abort", abort); }
}
