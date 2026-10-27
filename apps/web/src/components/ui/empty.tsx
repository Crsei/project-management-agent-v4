import type { ComponentProps, ReactNode } from "react"
import { Inbox } from "lucide-react"
import { useI18n } from "../../lib/i18n-provider"
import { cn } from "../../lib/utils"
export type EmptyProps = Omit<ComponentProps<"div">, "title"> & {
  title?: ReactNode
  description?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  headingLevel?: 2 | 3 | 4 | 5 | 6
}
export function Empty({
  title,
  description,
  icon,
  action,
  headingLevel = 3,
  className,
  children,
  ...props
}: EmptyProps) {
  const { t } = useI18n()
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4" | "h5" | "h6"
  return (
    <div
      {...props}
      className={cn(
        "flex min-h-40 flex-col items-center justify-center gap-3 p-6 text-center",
        className,
      )}
    >
      {icon ?? <Inbox aria-hidden="true" size={20} />}
      <Heading className="text-sm font-medium leading-5">
        {title ?? t("workspaceShellDemo.noContentYet")}
      </Heading>
      <p className="max-w-xs text-[13px] leading-5 text-muted-foreground">
        {description ?? t("dataRegion.noDataInThisScopeAdjustTheFilters")}
      </p>
      {action}
      {children}
    </div>
  )
}
