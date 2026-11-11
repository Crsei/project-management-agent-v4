export interface MetricSummary {
  /** Complete population total. Unknown observations keep this null. */
  total: number | null;
  mean: number | null;
  median: number | null;
  knownTotal: number | null;
  knownCount: number;
  unknownCount: number;
}

export function summarizeMetric(values: readonly (number | null)[]): MetricSummary {
  const known = values.filter((value): value is number => value !== null);
  if (known.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Report metrics must be finite nonnegative numbers or null');
  }
  const knownTotal = known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
  const complete = known.length === values.length && values.length > 0;
  const sorted = complete ? known.sort((left, right) => left - right) : known;
  const middle = Math.floor(sorted.length / 2);
  const median = !complete ? null : sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return {
    total: complete ? knownTotal : null,
    mean: complete ? knownTotal! / values.length : null,
    median,
    knownTotal,
    knownCount: known.length,
    unknownCount: values.length - known.length,
  };
}

export interface CostPerSuccess {
  usd: number | null;
  reason: 'no_successes' | 'unknown_cost' | null;
}

/** Includes the cost of failed attempts, not just the successful attempts. */
export function costPerSuccess(costs: readonly (number | null)[], successes: number): CostPerSuccess {
  if (!Number.isInteger(successes) || successes < 0 || successes > costs.length) {
    throw new Error('Success count must be an integer within the attempt count');
  }
  const total = summarizeMetric(costs).total;
  if (successes === 0) return { usd: null, reason: 'no_successes' };
  if (total === null) return { usd: null, reason: 'unknown_cost' };
  return { usd: total / successes, reason: null };
}

/** Descriptive interval only; repeated runs of a fixed task are not independent task samples. */
export function wilsonInterval(successes: number, attempts: number): { lower: number; upper: number } | null {
  if (!Number.isInteger(attempts) || !Number.isInteger(successes) || attempts < 0 || successes < 0 || successes > attempts) {
    throw new Error('Invalid binomial counts');
  }
  if (attempts === 0) return null;
  const z = 1.959963984540054;
  const proportion = successes / attempts;
  const denominator = 1 + z * z / attempts;
  const center = (proportion + z * z / (2 * attempts)) / denominator;
  const margin = z * Math.sqrt(proportion * (1 - proportion) / attempts + z * z / (4 * attempts * attempts)) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}
