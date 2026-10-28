"use client"
import { useI18n } from "../../lib/i18n-provider"
import {
  Ban,
  Check,
  Circle,
  CircleAlert,
  Clock3,
  ListOrdered,
  LoaderCircle,
  Pause,
  Play,
  Sparkles,
  HelpCircle,
} from "lucide-react"
import {
  isRuntimeStatus,
  runtimeStatusMeta,
  type RuntimeStatus,
} from "../../lib/runtime-status"
import { cn } from "../../lib/utils"
const icons = {
  idle: Circle,
  queued: ListOrdered,
  starting: LoaderCircle,
  running: Play,
  thinking: Sparkles,
  waiting: Clock3,
  paused: Pause,
  completed: Check,
  failed: CircleAlert,
  cancelled: Ban,
} satisfies Record<RuntimeStatus, typeof Circle>
export type RuntimeStatusBadgeProps = {
  status: string
  className?: string
  iconOnly?: boolean
}
export function RuntimeStatusBadge({
  status,
  className,
  iconOnly = false,
}: RuntimeStatusBadgeProps) {
  const { t, builtIn } = useI18n()

  const known = isRuntimeStatus(status)
  const meta = known
    ? runtimeStatusMeta[status]
    : {
        label: t("common.unknownStatusValue", { value0: status }),
        token: "status-waiting",
      }
  const Icon = known ? icons[status] : HelpCircle
  return (
    <span
      data-runtime-status={status}
      data-icon-only={iconOnly || undefined}
      title={iconOnly ? builtIn(meta.label) : undefined}
      className={cn(
        "inline-flex min-h-5 items-center gap-1 rounded-sm px-1 text-xs leading-4 whitespace-nowrap",
        className,
      )}
      style={{ color: `var(--${meta.token})` }}
    >
      <Icon size={12} strokeWidth={1.75} aria-hidden="true" />
      <span className={iconOnly ? "sr-only" : undefined}>
        {builtIn(meta.label)}
      </span>
    </span>
  )
}
