// Monotone curves and nice scales adapted from t3code UsageProviderChart.tsx.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
export interface ChartPoint { x: number; y: number }
export interface CurveSegment { from: ChartPoint; c1: ChartPoint; c2: ChartPoint; to: ChartPoint }

/** Fritsch–Carlson tangent limiting keeps each interval within its observations. */
export function monotoneCurve(points: readonly ChartPoint[]): CurveSegment[] {
  if (points.length < 2) return [];
  const slopes: number[] = [];
  const widths: number[] = [];
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1]!;
    const to = points[index]!;
    const width = to.x - from.x;
    if (width <= 0 || !Number.isFinite(width) || !Number.isFinite(from.y) || !Number.isFinite(to.y)) return [];
    widths.push(width);
    slopes.push((to.y - from.y) / width);
  }
  const tangents = points.map(() => 0);
  tangents[0] = slopes[0]!;
  tangents[points.length - 1] = slopes[slopes.length - 1]!;
  for (let index = 1; index < points.length - 1; index++) {
    const previous = slopes[index - 1]!;
    const next = slopes[index]!;
    if (previous === 0 || next === 0 || Math.sign(previous) !== Math.sign(next)) continue;
    const before = widths[index - 1]!;
    const after = widths[index]!;
    const w1 = 2 * after + before;
    const w2 = after + 2 * before;
    tangents[index] = (w1 + w2) / (w1 / previous + w2 / next);
  }
  for (let index = 0; index < slopes.length; index++) {
    const slope = slopes[index]!;
    if (slope === 0) {
      tangents[index] = tangents[index + 1] = 0;
      continue;
    }
    const a = tangents[index]! / slope;
    const b = tangents[index + 1]! / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[index] = scale * a * slope;
      tangents[index + 1] = scale * b * slope;
    }
  }
  return slopes.map((_, index) => {
    const from = points[index]!;
    const to = points[index + 1]!;
    const dx = widths[index]! / 3;
    const clampY = (y: number) => Math.max(Math.min(from.y, to.y), Math.min(Math.max(from.y, to.y), y));
    return {
      from,
      c1: { x: from.x + dx, y: clampY(from.y + tangents[index]! * dx) },
      c2: { x: to.x - dx, y: clampY(to.y - tangents[index + 1]! * dx) },
      to,
    };
  });
}

export function curvePath(points: readonly ChartPoint[]): string {
  const first = points[0];
  if (!first) return "";
  let path = `M${first.x.toFixed(3)},${first.y.toFixed(3)}`;
  for (const segment of monotoneCurve(points)) {
    path += ` C${segment.c1.x.toFixed(3)},${segment.c1.y.toFixed(3)} ${segment.c2.x.toFixed(3)},${segment.c2.y.toFixed(3)} ${segment.to.x.toFixed(3)},${segment.to.y.toFixed(3)}`;
  }
  return path;
}

/** Separate runs, rather than a zero or an interpolated bridge, for unknown periods. */
export function knownPointRuns(points: readonly (ChartPoint | null)[]): ChartPoint[][] {
  const runs: ChartPoint[][] = [];
  let run: ChartPoint[] = [];
  for (const point of points) {
    if (point) run.push(point);
    else if (run.length) { runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  return runs;
}

export function niceScale(peak: number, count = 4): { max: number; ticks: number[] } {
  if (!Number.isFinite(peak) || peak <= 0) return { max: 0, ticks: [0] };
  const rawStep = peak / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  const intervals = Math.ceil(peak / step);
  return { max: intervals * step, ticks: Array.from({ length: intervals + 1 }, (_, index) => index * step) };
}
