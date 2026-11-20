import assert from "node:assert/strict";
import test from "node:test";
import { detailsDensity, detailsPresentation, scrollFade } from "./thread-details-model.ts";

test("density tiers follow the reported content height", () => {
  assert.equal(detailsDensity(0), "full");
  assert.equal(detailsDensity(Number.NaN), "full");
  assert.equal(detailsDensity(120), "essential");
  assert.equal(detailsDensity(220), "essential");
  assert.equal(detailsDensity(221), "compact");
  assert.equal(detailsDensity(460), "compact");
  assert.equal(detailsDensity(461), "full");
});

test("details stay inline only on wide non-embedded chat", () => {
  assert.equal(detailsPresentation({ wide: true, embedded: false }), "inline");
  assert.equal(detailsPresentation({ wide: true, embedded: true }), "overlay");
  assert.equal(detailsPresentation({ wide: false, embedded: false }), "overlay");
});

test("scroll fade only appears on the edges that hide content", () => {
  assert.equal(scrollFade({ scrollTop: 0, scrollHeight: 200, clientHeight: 200 }), "none");
  assert.equal(scrollFade({ scrollTop: 0, scrollHeight: 600, clientHeight: 400 }), "bottom");
  assert.equal(scrollFade({ scrollTop: 200, scrollHeight: 600, clientHeight: 400 }), "top");
  assert.equal(scrollFade({ scrollTop: 120, scrollHeight: 600, clientHeight: 400 }), "both");
  assert.equal(scrollFade({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }), "none");
});
