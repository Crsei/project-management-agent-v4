import assert from "node:assert/strict";
import { test } from "node:test";
import { knownPointRuns, monotoneCurve, niceScale } from "./usage-chart-math.ts";

test("smooth spike and plateau curves stay inside every observed interval without negative usage", () => {
  const samples = [
    [0, 0, 100, 0, 0, 1, 0],
    [0, 100, 100, 0, 0, 0],
    [10, 11, 1000, 1000.01, 1001],
    [1001, 1000.01, 1000, 11, 10],
  ];
  for (const values of samples) {
    // Uneven x spacing also covers a short final input interval.
    const points = values.map((y, index) => ({ x: index * index + index, y }));
    const segments = monotoneCurve(points);
    assert.equal(segments.length, points.length - 1);
    for (const segment of segments) {
      const minimum = Math.min(segment.from.y, segment.to.y);
      const maximum = Math.max(segment.from.y, segment.to.y);
      for (let step = 0; step <= 100; step++) {
        const t = step / 100;
        const u = 1 - t;
        const y = u ** 3 * segment.from.y + 3 * u * u * t * segment.c1.y + 3 * u * t * t * segment.c2.y + t ** 3 * segment.to.y;
        assert.ok(y >= minimum - 1e-9 && y <= maximum + 1e-9, `${y} outside [${minimum}, ${maximum}]`);
      }
    }
  }
});

test("unknown periods split curves while observed zeroes remain in the same curve", () => {
  const before = { x: 0, y: 0 };
  const zero = { x: 1, y: 0 };
  const after = { x: 3, y: 20 };
  assert.deepEqual(knownPointRuns([before, zero, null, after, null]), [[before, zero], [after]]);
  assert.deepEqual(knownPointRuns([null, null]), []);
  assert.deepEqual(monotoneCurve([before]), []);
  assert.deepEqual(monotoneCurve([before, { x: 0, y: 5 }]), [], "duplicate instants must not produce an invalid curve");
});

test("nice axes bound tiny and large peaks and keep real zero distinct from a fabricated nonzero scale", () => {
  assert.deepEqual(niceScale(0), { max: 0, ticks: [0] });
  for (const peak of [.000000013, .84, 4, 11, 160_000_000, 2_100_000_000]) {
    const scale = niceScale(peak);
    assert.ok(scale.max >= peak);
    assert.ok(scale.max < peak * 2);
    assert.equal(scale.ticks[0], 0);
    assert.equal(scale.ticks[scale.ticks.length - 1], scale.max);
    assert.ok(scale.ticks.length >= 3 && scale.ticks.length <= 6);
    const step = scale.ticks[1]!;
    for (let index = 1; index < scale.ticks.length; index++) assert.ok(Math.abs((scale.ticks[index]! - scale.ticks[index - 1]!) / step - 1) < 1e-9);
  }
});
