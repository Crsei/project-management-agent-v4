import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react"
// React uses the server snapshot during hydration and the client snapshot once
// event handlers are installed; no timer or manually scheduled state update.
const unsubscribeControls = () => {}
const subscribeControls = () => unsubscribeControls
const clientControlsSnapshot = () => true
const serverControlsSnapshot = () => false
export function usePmControlsReady() {
  return useSyncExternalStore(subscribeControls, clientControlsSnapshot, serverControlsSnapshot)
}

type Store<T> = {
  snapshot: () => T
  subscribe: (listener: () => void) => () => void
  update: Dispatch<SetStateAction<T>>
}
function createStore<T>(initial: T): Store<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    snapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update: (action) => {
      const next =
        typeof action === "function" ? (action as (old: T) => T)(value) : action
      if (Object.is(next, value)) return
      value = next
      listeners.forEach((listener) => listener())
    },
  }
}
export type PmDomainCache = Map<string, unknown>
const DomainContext = createContext<{
  cache: PmDomainCache
  navigate: (slug: string, entityId?: string) => void
  entityId: string | null
  back: (fallbackSlug: string) => void
} | null>(null)
export function PmDomainProvider({
  cache,
  navigate,
  back,
  entityId,
  children,
}: {
  cache: PmDomainCache
  navigate: (slug: string, entityId?: string) => void
  entityId: string | null
  back: (fallbackSlug: string) => void
  children: ReactNode
}) {
  return (
    <DomainContext.Provider value={{ cache, navigate, back, entityId }}>
      {children}
    </DomainContext.Provider>
  )
}
export function usePmNavigation() {
  const value = useContext(DomainContext)
  if (!value) throw new Error("PM domain requires its Lab provider")
  return {
    navigate: value.navigate,
    back: value.back,
    entityId: value.entityId,
  }
}
const restoredStores = new WeakMap<object, WeakMap<object, unknown>>()

function canonicalStore<T>(store: Store<T>, restore: (cached: unknown) => T): Store<T> {
  let restorations = restoredStores.get(store)
  const existing = restorations?.get(restore) as Store<T> | undefined
  if (existing) return existing
  let previous = store.snapshot()
  let next = restore(previous)
  let pending = !Object.is(previous, next)
  const snapshot = () => {
    if (!pending) return store.snapshot()
    const current = store.snapshot()
    if (!Object.is(current, previous)) {
      previous = current
      next = restore(current)
    }
    return next
  }
  const canonical: Store<T> = pending ? {
    snapshot,
    subscribe(listener) {
      const migrated = snapshot()
      pending = false
      // useSyncExternalStore subscribes after commit; existing consumers are
      // notified without a render-phase update, before registering this one.
      store.update(() => migrated)
      return store.subscribe(listener)
    },
    update: store.update,
  } : store
  if (!restorations) {
    restorations = new WeakMap()
    restoredStores.set(store, restorations)
  }
  restorations.set(restore, canonical)
  return canonical
}

export function usePmDomainState<T>(
  key: string,
  create: () => T,
  restore?: (cached: unknown) => T,
): [T, Dispatch<SetStateAction<T>>] {
  const context = useContext(DomainContext)
  if (!context) throw new Error("PM domain requires its Lab provider")
  let store = context.cache.get(key) as Store<T> | undefined
  if (!store) {
    store = createStore(create())
    context.cache.set(key, store)
  }
  const subscribedStore = restore ? canonicalStore(store, restore) : store
  const value = useSyncExternalStore(
    subscribedStore.subscribe,
    subscribedStore.snapshot,
    subscribedStore.snapshot,
  )
  const update = store.update
  return [value, update]
}
