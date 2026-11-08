/** Share a route's in-flight module request without caching a failed load forever. */
export function createRouteModuleLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(load).catch(error => {
        pending = undefined
        throw error
      })
    }
    return pending
  }
}
