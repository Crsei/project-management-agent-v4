import { useId, type ReactNode } from "react"

export type SettingsPageProps = { mode: "service" | "lab" }

export function SettingsSection({ title, description, children, wide = false }: {
  title: string
  description?: string
  children: ReactNode
  wide?: boolean
}) {
  const headingId = useId()
  return <section aria-labelledby={headingId} className="min-w-0">
    <header className="mb-6 space-y-1 border-b pb-4">
      <h2 id={headingId} className="text-lg font-semibold">{title}</h2>
      {description ? <p className="text-sm leading-6 text-muted-foreground">{description}</p> : null}
    </header>
    <div className={`min-w-0 space-y-6 ${wide ? "" : "max-w-xl"}`}>{children}</div>
  </section>
}

export function SettingsNotice({ children }: { children: ReactNode }) {
  return <div role="note" className="rounded-module border bg-surface-raised p-4 text-sm leading-6 text-muted-foreground">{children}</div>
}
