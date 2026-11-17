import assert from "node:assert/strict";
import test from "node:test";
import { parseStoredPanelWidth } from "./right-panel-width.ts";

test("stored panel width accepts only finite values at or above the minimum", () => {
  assert.equal(parseStoredPanelWidth(null, 320), undefined);
  assert.equal(parseStoredPanelWidth("", 320), undefined);
  assert.equal(parseStoredPanelWidth("abc", 320), undefined);
  assert.equal(parseStoredPanelWidth("-1", 320), undefined);
  assert.equal(parseStoredPanelWidth("320", 320), 320);
  assert.equal(parseStoredPanelWidth("540.5", 320), 540.5);
  assert.equal(parseStoredPanelWidth("Infinity", 320), undefined);
});
