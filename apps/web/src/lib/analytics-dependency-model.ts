import { analyticsEntityKey, type AnalyticsEntityRef } from "./analytics-model"
export type WorkDependency = {
  id: string
  from: AnalyticsEntityRef
  to: AnalyticsEntityRef
  state: "blocked" | "satisfied" | "unknown"
  evidence: string
}
/** Strongly connected components: downstream nodes of a cycle are not themselves cyclic. */
export function dependencyCycles(edges: readonly WorkDependency[]): string[][] {
  const nodes = new Set<string>(),
    adj = new Map<string, string[]>(),
    ids = new Set<string>()
  for (const e of edges) {
    if (ids.has(e.id)) throw new Error("Duplicate dependency")
    ids.add(e.id)
    const a = analyticsEntityKey(e.from),
      b = analyticsEntityKey(e.to)
    nodes.add(a)
    nodes.add(b)
    adj.set(a, [...(adj.get(a) ?? []), b])
  }
  const index = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: string[] = [],
    active = new Set<string>(),
    cycles: string[][] = []
  let count = 0
  function visit(v: string) {
    index.set(v, count)
    low.set(v, count++)
    stack.push(v)
    active.add(v)
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (active.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!))
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = []
      let w: string
      do {
        w = stack.pop()!
        active.delete(w)
        component.push(w)
      } while (w !== v)
      if (component.length > 1 || (adj.get(v) ?? []).includes(v))
        cycles.push(component.sort())
    }
  }
  for (const n of nodes) if (!index.has(n)) visit(n)
  return cycles
}
