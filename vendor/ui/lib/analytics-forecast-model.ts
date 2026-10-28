import { analyticsBucketId } from "./analytics-history"
import type { AnalyticsEntityRef } from "./analytics-model"
export type ForecastMethod = {
  id: "empirical-bootstrap"
  version: 1
  minSamples: number
  draws: number
  maxDays: number
  calibrationOrigins: number
  minCalibrationOrigins: number
  minP85Coverage: number
  staleAfterMs: number
  seed: number
}
export type ForecastResult = {
  method: ForecastMethod
  generatedAt: string
  historicalWindow: { from: string; to: string }
  snapshotId: string
  timeZone: string
  calendarVersion: string
  scopeId: string
  remaining: readonly AnalyticsEntityRef[]
  historicalMembers: readonly AnalyticsEntityRef[]
  samples: number
  scopeStable: boolean
  assumptions: readonly string[]
  status: "available" | "insufficient" | "uncalibrated" | "stale"
  reason: string | null
  quantiles: { probability: number; days: number | null; date: string | null }[]
  calibration: { origins: number; p85Coverage: number | null; method: string }
  simulatedDays: readonly number[]
}
function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}
function simulate(
  values: readonly number[],
  remaining: number,
  method: ForecastMethod,
  seed: number,
) {
  const rand = random(seed)
  return Array.from({ length: method.draws }, () => {
    let done = 0,
      days = 0
    while (done < remaining && days < method.maxDays) {
      done += values[Math.floor(rand() * values.length)]
      days++
    }
    return done >= remaining ? days : Infinity
  })
}
/** Example/small-data adapter. Historical daily observations include true zero days. No extrapolated future tasks. */
export function sampleThroughputForecast(input: {
  method: ForecastMethod
  throughput: readonly number[]
  remaining: readonly AnalyticsEntityRef[]
  historicalMembers: readonly AnalyticsEntityRef[]
  generatedAt: string
  asOf: string
  historicalWindow: { from: string; to: string }
  snapshotId: string
  timeZone: string
  calendarVersion: string
  scopeId: string
  scopeStable: boolean
  historyComplete: boolean
}): ForecastResult {
  const { method, throughput } = input
  if (
    !Number.isInteger(method.minSamples) ||
    method.minSamples < 1 ||
    !Number.isInteger(method.draws) ||
    method.draws < 1 ||
    method.draws > 10000 ||
    !Number.isInteger(method.maxDays) ||
    method.maxDays < 1 ||
    method.maxDays > 10000 ||
    !Number.isInteger(method.calibrationOrigins) ||
    method.calibrationOrigins < 0 ||
    !Number.isInteger(method.minCalibrationOrigins) ||
    method.minCalibrationOrigins < 1 ||
    !(method.minP85Coverage >= 0 && method.minP85Coverage <= 1) ||
    method.staleAfterMs < 0 ||
    !Number.isFinite(Date.parse(input.generatedAt)) ||
    !Number.isFinite(Date.parse(input.asOf))
  )
    throw new Error("Invalid forecast method")
  if (throughput.some((v) => !Number.isSafeInteger(v) || v < 0))
    throw new Error("Throughput must be observed nonnegative item counts")
  if (
    Date.parse(input.generatedAt) > Date.parse(input.asOf) ||
    !Number.isFinite(Date.parse(input.historicalWindow.from)) ||
    !Number.isFinite(Date.parse(input.historicalWindow.to)) ||
    Date.parse(input.historicalWindow.from) >=
      Date.parse(input.historicalWindow.to) ||
    Date.parse(input.historicalWindow.to) > Date.parse(input.generatedAt)
  )
    throw new Error("Invalid forecast observation window")
  const observed = throughput.length,
    hits: boolean[] = []
  // Rolling-origin delivery backtest. Each origin predicts this cohort size from its past only.
  for (let i = method.minSamples; i < observed; i++) {
    let done = 0,
      elapsed = 0
    while (done < input.remaining.length && i + elapsed < observed) {
      done += throughput[i + elapsed]
      elapsed++
    }
    if (done < input.remaining.length) continue // no complete future outcome; cannot score this origin
    const training = throughput.slice(0, i),
      draws = simulate(
        training,
        input.remaining.length,
        method,
        method.seed + i,
      ).sort((a, b) => a - b)
    hits.push(elapsed <= draws[Math.ceil(0.85 * draws.length) - 1])
  }
  const calibration = method.calibrationOrigins
      ? hits.slice(-method.calibrationOrigins)
      : [],
    n = calibration.length,
    coverage = n ? calibration.filter(Boolean).length / n : null
  const expired =
    Date.parse(input.asOf) - Date.parse(input.generatedAt) > method.staleAfterMs
  const insufficient =
    !input.historyComplete ||
    !input.scopeStable ||
    observed < method.minSamples ||
    (!throughput.some((v) => v > 0) && input.remaining.length > 0)
  const status: ForecastResult["status"] = expired
    ? "stale"
    : insufficient
      ? "insufficient"
      : n < method.minCalibrationOrigins ||
          coverage === null ||
          coverage < method.minP85Coverage
        ? "uncalibrated"
        : "available"
  const draws =
    status === "available"
      ? simulate(throughput, input.remaining.length, method, method.seed)
      : []
  // Failed simulations remain censored, never silently dropped from the quantile denominator.
  const sorted = [...draws].sort((a, b) => a - b)
  const quantiles = [0.5, 0.85, 0.95].map((probability) => {
    const value = sorted.length
      ? sorted[Math.ceil(probability * sorted.length) - 1]
      : null
    const days = value !== null && Number.isFinite(value) ? value : null
    return {
      probability,
      days,
      date:
        days === null
          ? null
          : new Date(
              Date.parse(
                analyticsBucketId(input.generatedAt, "day", input.timeZone) +
                  "T12:00:00Z",
              ) +
                days * 86400000,
            )
              .toISOString()
              .slice(0, 10),
    }
  })
  return {
    method,
    generatedAt: input.generatedAt,
    historicalWindow: input.historicalWindow,
    snapshotId: input.snapshotId,
    timeZone: input.timeZone,
    calendarVersion: input.calendarVersion,
    scopeId: input.scopeId,
    remaining: input.remaining,
    historicalMembers: input.historicalMembers,
    samples: observed,
    scopeStable: input.scopeStable,
    assumptions: ["analytics.forecastAssumptions"],
    status,
    reason: status === "available" ? null : `analytics.forecast.${status}`,
    quantiles,
    calibration: {
      origins: n,
      p85Coverage: coverage,
      method:
        "rolling-origin completion-days P85 for the same cohort size; calendar days; incomplete outcomes excluded",
    },
    simulatedDays: draws.map((v) => (Number.isFinite(v) ? v : -1)),
  }
}
