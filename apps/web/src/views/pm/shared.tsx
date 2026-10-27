import {
  createContext,
  useCallback,
  useContext,
  type ComponentProps,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react"
import { PmPage as PresentationPage } from "./presentation-page"
export { PmSearch } from "./presentation-page"
import { Avatar } from "@/components/ui/avatar"
import { DataRegion } from "@/components/ui/data-region"
import { useI18n } from "@/lib/i18n-provider"
import type { PmMember, PmScenario } from "./model"
import { usePmControlsReady } from "./domain-session"

type ScenarioCache = Map<string, unknown>
const CacheContext = createContext<ScenarioCache | null>(null)
export function PmScenarioProvider({
  cache,
  children,
}: {
  cache: ScenarioCache
  children: ReactNode
}) {
  return <CacheContext.Provider value={cache}>{children}</CacheContext.Provider>
}
export function usePmScenarioState<T>(
  key: string,
  create: () => T,
  restore?: (cached: unknown) => T,
): [T, Dispatch<SetStateAction<T>>] {
  const cache = useContext(CacheContext)
  const [state, setState] = useState<T>(() => {
    if (!cache?.has(key)) return create()
    const cached = cache.get(key)
    if (!restore) return cached as T
    const restored = restore(cached)
    cache.set(key, restored)
    return restored
  })
  const current = useRef(state)
  const update = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      const next =
        typeof action === "function"
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
/** Fixture-session adapter around the one neutral page renderer. */
export function PmPage(props: ComponentProps<typeof PresentationPage>) {
  const cache = useContext(CacheContext)
  const interactive = usePmControlsReady()
  return <PresentationPage {...props} interactive={props.interactive ?? interactive} readingPosition={props.readingPosition ?? Number(cache?.get("reading-position") ?? 0)} onReadingPositionChange={props.onReadingPositionChange ?? ((top) => cache?.set("reading-position", top))} />
}
export function PmMemberIdentity({
  member,
  detail = false,
}: {
  member: PmMember
  detail?: boolean
}) {
  const { locale } = useI18n()
  return (
    <span
      className="inline-flex min-w-0 items-center gap-2"
      data-pm-member={member.id}
    >
      <Avatar name={member.name} size={24} />
      <span className="min-w-0">
        <span className="block truncate text-sm">{member.name}</span>
        {detail && (
          <span className="block text-xs text-muted-foreground">
            {member.role[locale]}
          </span>
        )}
      </span>
    </span>
  )
}
export function PmDataBoundary({
  scenario,
  empty,
  emptyDescription,
  children,
}: {
  scenario: PmScenario
  empty: boolean
  emptyDescription: string
  children: ReactNode
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const [retried, setRetried] = usePmScenarioState(
    "read-recovered",
    () => false,
  )
  return (
    <DataRegion
      state={
        scenario === "loading"
          ? "loading"
          : scenario === "refresh-error" && !retried
            ? "error"
            : empty
              ? "empty"
              : "success"
      }
      hasContent={!empty && scenario !== "loading"}
      emptyTitle={en ? "Nothing to display" : "暂无内容"}
      emptyDescription={emptyDescription}
      emptyHeadingLevel={2}
      loadingLabel={en ? "Loading local scene" : "正在加载本地场景"}
      error={{
        category: "network",
        message: en ? "The simulated refresh failed." : "模拟刷新失败。",
        reason: en
          ? "Your existing data and edits are retained."
          : "已有数据和编辑已保留。",
      }}
      onRetry={
        scenario === "refresh-error" ? () => setRetried(true) : undefined
      }
    >
      {children}
    </DataRegion>
  )
}
