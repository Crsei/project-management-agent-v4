/** Hidden PM tabs release their long-lived HTTP/1.1 streams, not their drafts or task runs. */
export type VisibilitySource = {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
};
export function createPageVisibilityStore(source?: VisibilitySource) {
  return {
    getSnapshot: () => source?.visibilityState === 'visible',
    getServerSnapshot: () => false,
    subscribe: (notify: () => void) => {
      source?.addEventListener('visibilitychange', notify);
      return () => source?.removeEventListener('visibilitychange', notify);
    },
  };
}
export const pageVisibility = createPageVisibilityStore((globalThis as typeof globalThis & { document?: VisibilitySource }).document);
