import type { PmScenario } from "@/views/pm/model"

const scenarios: readonly PmScenario[] = [
  "default",
  "empty",
  "loading",
  "refresh-error",
  "readonly",
  "long-content",
]

/** Routes accept `?scenario=` so the same fixture states the Lab exposes are reachable. */
export function parseScenario(value: string | string[] | undefined): PmScenario {
  const raw = Array.isArray(value) ? value[0] : value
  return scenarios.includes(raw as PmScenario) ? (raw as PmScenario) : "default"
}
