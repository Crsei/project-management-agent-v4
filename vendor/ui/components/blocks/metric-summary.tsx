import type { ReactNode } from "react"
export type MetricSummaryItem = {
  id: string
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  description?: ReactNode
  visual?: ReactNode
}
export function MetricSummary({
  items,
  className,
}: {
  items: readonly MetricSummaryItem[]
  className?: string
}) {
  return (
    <dl className={className ?? "grid grid-cols-2 gap-4 py-4 sm:grid-cols-4"}>
      {items.map((item) => (
        <div key={item.id} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="mt-1 break-words text-xl font-medium tabular-nums">
            {item.value}
            {item.unit && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {item.unit}
              </span>
            )}
          </dd>
          {item.description && (
            <dd className="mt-1 text-xs text-muted-foreground">
              {item.description}
            </dd>
          )}
          {item.visual && <dd className="mt-2">{item.visual}</dd>}
        </div>
      ))}
    </dl>
  )
}
