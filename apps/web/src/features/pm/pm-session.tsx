import { createContext, useContext, useMemo, useState, type ReactNode } from "react"

export type PmActor = { userId: string; name?: string | null }
export type PmSession = {
  backend: "demo"
  actor: PmActor | null
  user: { name: string; email: string } | null
  workspaces: string[]
}

/** Explicit Lab session. Never used by the real service provider. */
const demoSession: PmSession = {
  backend: "demo",
  actor: { userId: "demo-user", name: "演示用户" },
  user: { name: "演示用户", email: "demo@local" },
  workspaces: ["execra-ai"],
}

const PmClientContext = createContext<{
  session: PmSession
  pending: boolean
  domains: Map<string, Map<string, unknown>>
  pages: Map<string, Map<string, unknown>>
} | null>(null)

export function pmActorKey(actor: PmActor | null) {
  return actor ? `${actor.userId}` : "anonymous"
}

export function PmProvider({ children }: { children: ReactNode }) {
  const [session] = useState<PmSession>(demoSession)
  const [domains] = useState(() => new Map<string, Map<string, unknown>>())
  const [pages] = useState(() => new Map<string, Map<string, unknown>>())
  const value = useMemo(() => ({ session, pending: false, domains, pages }), [session, domains, pages])
  return <PmClientContext.Provider value={value}>{children}</PmClientContext.Provider>
}

export function usePmClient() {
  const client = useContext(PmClientContext)
  if (!client) throw new Error("Pm provider is missing")
  return client
}
