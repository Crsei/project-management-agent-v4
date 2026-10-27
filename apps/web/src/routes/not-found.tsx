import { Link, useLocation } from "react-router"
import { ErrorPageScreen } from "@/components/blocks/error-page"
import { useI18n } from "@/lib/i18n-provider"

/** Unmatched path: uses the same 404 surface as the explicit error routes. */
export function PmNotFound() {
  const { locale } = useI18n()
  const location = useLocation()
  return (
    <ErrorPageScreen
      code={404}
      detail={
        <>
          {locale === "en" ? "No route matches " : "没有匹配的路由："}
          <code className="break-all">{location.pathname}</code>
        </>
      }
    />
  )
}

/**
 * Stand-in for `notFound()` on a route whose `?view=` value is outside the
 * whitelist: names the accepted variants instead of rendering a blank page.
 */
export function PmViewNotFound({
  feature,
  value,
  variants,
  backHref,
}: {
  feature: string
  value: string
  variants: readonly string[]
  backHref: string
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  return (
    <main className="p-6">
      <h1 className="text-xl font-semibold">
        {en ? "View not found" : "视图不存在"}
      </h1>
      <p className="mt-3 text-[13px] text-muted-foreground">
        {en ? `${feature} has no view "?view=` : `${feature} 没有视图 "?view=`}
        {value}
        {en ? `". Available: ${variants.join(", ")}.` : `"，可用视图：${variants.join("、")}。`}
      </p>
      <Link
        to={backHref}
        className="mt-6 inline-block rounded-control border px-4 py-2 text-[13px] hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        {en ? "Open the default view" : "打开默认视图"}
      </Link>
    </main>
  )
}
