import assert from "node:assert/strict";
import test from "node:test";
import { shouldFocusComposerForPaste, type PasteFocusFacts } from "./composer-paste-focus.ts";

const facts = (patch: Partial<PasteFocusFacts> = {}): PasteFocusFacts => ({
  eventDefaultPrevented: false, insideEditable: false, insideInteractive: false, floatingLayerOpen: false, ...patch,
});

test("a paste over inert chat content goes to the composer", () => {
  assert.equal(shouldFocusComposerForPaste(facts()), true);
});

test("editors, controls and open layers keep their own paste", () => {
  assert.equal(shouldFocusComposerForPaste(facts({ insideEditable: true })), false);
  assert.equal(shouldFocusComposerForPaste(facts({ insideInteractive: true })), false);
  assert.equal(shouldFocusComposerForPaste(facts({ floatingLayerOpen: true })), false);
  assert.equal(shouldFocusComposerForPaste(facts({ eventDefaultPrevented: true })), false);
});
