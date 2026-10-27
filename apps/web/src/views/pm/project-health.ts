export type ProjectHealthBand = "on-track" | "at-risk" | "off-track" | "unknown"
export const projectHealthBands: readonly ProjectHealthBand[] = [
  "on-track",
  "at-risk",
  "off-track",
  "unknown",
]
/** Shared project assessment thresholds; missing and non-finite values remain unknown. */
export function projectHealthBand(health: number | null): ProjectHealthBand {
  if (health === null || !Number.isFinite(health)) return "unknown"
  return health >= 70 ? "on-track" : health >= 40 ? "at-risk" : "off-track"
}
