"use client"

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react"

const PageCacheContext = createContext<Map<string, unknown> | null>(null)

/** The Lab owns the cache lifetime and provides a separate map per page/scenario. */
export function RemainingPageStateProvider({
  cache,
  children,
}: {
  cache: Map<string, unknown>
  children: ReactNode
}) {
  return <PageCacheContext.Provider value={cache}>{children}</PageCacheContext.Provider>
}

export function useRemainingPageState<T>(
  key: string,
  create: () => T,
): [T, Dispatch<SetStateAction<T>>] {
  const cache = useContext(PageCacheContext)
  const [state, setState] = useState<T>(() =>
    cache?.has(key) ? (cache.get(key) as T) : create(),
  )
  const current = useRef(state)
  const update = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      const next = typeof action === "function"
        ? (action as (previous: T) => T)(current.current)
        : action
      current.current = next
      cache?.set(key, next)
      setState(next)
    },
    [cache, key],
  )
  return [state, update]
}
