import { useSearchParams } from "react-router"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n-provider"
import { statusLabel } from "../components/service-collection-shared"

export function PmDashboardFilter() {
  const [params, setParams] = useSearchParams()
  const { locale } = useI18n()
  const state = params.get("state")
  const overdue = params.get("overdue") === "1"
  if (!state && !overdue) return null
  return <div className="flex flex-wrap items-center gap-2 px-4 text-sm" role="status">
    <span>{locale === "en" ? "Dashboard filter:" : "概览筛选："} {state ? statusLabel(state, locale) : ""} {overdue ? locale === "en" ? "Overdue" : "已逾期" : ""}</span>
    <Button variant="outline" onClick={() => { const next = new URLSearchParams(params); next.delete("state"); next.delete("overdue"); setParams(next) }}>{locale === "en" ? "Clear dashboard filter" : "清除概览筛选"}</Button>
  </div>
}
