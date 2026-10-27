import type { ReactNode } from "react"

export function CoreBusinessPanel({ title, children }: { title: string; children: ReactNode }) {
  return <details className="min-w-0 rounded-lg border bg-surface">
    <summary className="cursor-pointer px-4 py-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{title}</summary>
    <div className="min-w-0 space-y-4 border-t p-4">{children}</div>
  </details>
}
