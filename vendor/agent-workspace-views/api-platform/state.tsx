"use client"
import {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react"
export type ApCache = Map<string, unknown>
const CacheContext = createContext<ApCache | null>(null)
export function ApStateProvider({
  cache,
  children,
}: {
  cache: ApCache
  children: ReactNode
}) {
  return <CacheContext.Provider value={cache}>{children}</CacheContext.Provider>
}
export function useApCache() {
  return useContext(CacheContext)
}
export function useApState<T>(
  key: string,
  create: () => T,
): [T, Dispatch<SetStateAction<T>>] {
  const cache = useApCache()
  const [state, setState] = useState<T>(() =>
    cache?.has(key) ? (cache.get(key) as T) : create(),
  )
  const current = useRef(state)
  const update = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      const next =
        typeof action === "function"
          ? (action as (before: T) => T)(current.current)
          : action
      current.current = next
      cache?.set(key, next)
      setState(next)
    },
    [cache, key],
  )
  return [state, update]
}
