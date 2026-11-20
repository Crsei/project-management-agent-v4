import assert from "node:assert/strict";
import test from "node:test";
import {
  conflictingActions, defaultComposerKeymap, findComposerKeymapConflicts, formatShortcutChord, matchComposerAction,
  matchesShortcutChord, normalizeShortcutChord, parseShortcutChord, rebindComposerKeymap, resetComposerKeymapBinding,
  resolveComposerKeymap, shortcutChordFromEvent,
} from "./composer-shortcuts.ts";

const event = (key: string, modifiers: Partial<{ ctrl: boolean; meta: boolean; alt: boolean; shift: boolean }> = {}) => ({
  key, ctrlKey: !!modifiers.ctrl, metaKey: !!modifiers.meta, altKey: !!modifiers.alt, shiftKey: !!modifiers.shift,
});

test("defaults keep Enter sending and Shift+Enter breaking the line", () => {
  assert.deepEqual(defaultComposerKeymap("enter"), { send: "Enter", newline: "Shift+Enter", steer: "Mod+Shift+Enter", togglePlan: "Shift+Tab" });
  assert.deepEqual(defaultComposerKeymap("ctrlEnter"), { send: "Mod+Enter", newline: "Enter", steer: "Mod+Shift+Enter", togglePlan: "Shift+Tab" });
});

test("chords parse, normalize and reject unusable bindings", () => {
  assert.deepEqual(parseShortcutChord("Mod+Shift+Enter"), { key: "Enter", mod: true, ctrl: false, meta: false, alt: false, shift: true });
  assert.deepEqual(parseShortcutChord("ctrl+k"), { key: "k", mod: false, ctrl: true, meta: false, alt: false, shift: false });
  assert.deepEqual(parseShortcutChord("shift+tab"), { key: "Tab", mod: false, ctrl: false, meta: false, alt: false, shift: true });
  assert.equal(normalizeShortcutChord("cmd + shift + enter"), "Meta+Shift+Enter");
  assert.equal(normalizeShortcutChord("Enter"), "Enter");
  assert.equal(normalizeShortcutChord("Mod+K"), "Mod+K");
  // A bare letter would swallow typing; unknown names and doubled modifiers are unusable.
  assert.equal(normalizeShortcutChord("a"), undefined);
  assert.equal(normalizeShortcutChord("Mod+"), undefined);
  assert.equal(normalizeShortcutChord("Mod+Mod+Enter"), undefined);
  assert.equal(normalizeShortcutChord("Hyper+Enter"), undefined);
  assert.equal(normalizeShortcutChord(42), undefined);
});

test("matching is exact about modifiers and follows the platform", () => {
  assert.equal(matchesShortcutChord("Enter", event("Enter"), false), true);
  assert.equal(matchesShortcutChord("Enter", event("Enter", { shift: true }), false), false);
  assert.equal(matchesShortcutChord("Mod+Enter", event("Enter", { ctrl: true }), false), true);
  assert.equal(matchesShortcutChord("Mod+Enter", event("Enter", { meta: true }), false), false);
  assert.equal(matchesShortcutChord("Mod+Enter", event("Enter", { meta: true }), true), true);
  assert.equal(matchesShortcutChord("Mod+Enter", event("Enter", { ctrl: true, shift: true }), false), false);
  assert.equal(matchesShortcutChord("Shift+Tab", event("Tab", { shift: true }), false), true);
});

test("event chords are canonical and ignore modifier-only presses", () => {
  assert.equal(shortcutChordFromEvent(event("Enter", { ctrl: true })), "Mod+Enter");
  assert.equal(shortcutChordFromEvent(event("k", { meta: true, shift: true })), "Mod+Shift+K");
  assert.equal(shortcutChordFromEvent(event("Tab", { shift: true })), "Shift+Tab");
  assert.equal(shortcutChordFromEvent(event("Control", { ctrl: true })), undefined);
  assert.equal(shortcutChordFromEvent(event("Shift", { shift: true })), undefined);
});

test("composer actions resolve in order and keep Ctrl+Enter sending in Enter mode", () => {
  const enter = defaultComposerKeymap("enter");
  assert.equal(matchComposerAction(enter, event("Enter"), false), "send");
  assert.equal(matchComposerAction(enter, event("Enter", { ctrl: true }), false), "send");
  assert.equal(matchComposerAction(enter, event("Enter", { shift: true }), false), "newline");
  assert.equal(matchComposerAction(enter, event("Enter", { ctrl: true, shift: true }), false), "steer");
  assert.equal(matchComposerAction(enter, event("Tab", { shift: true }), false), "togglePlan");
  const ctrlEnter = defaultComposerKeymap("ctrlEnter");
  assert.equal(matchComposerAction(ctrlEnter, event("Enter"), false), "newline");
  assert.equal(matchComposerAction(ctrlEnter, event("Enter", { ctrl: true }), false), "send");
});

test("overrides win per action and invalid stored chords fall back to defaults", () => {
  const keymap = resolveComposerKeymap({ send: "Mod+Enter", newline: "Mod+Shift+Enter" }, "enter");
  assert.equal(keymap.send, "Mod+Enter");
  assert.equal(keymap.newline, "Mod+Shift+Enter");
  assert.equal(keymap.togglePlan, "Shift+Tab");
  const invalid = resolveComposerKeymap({ send: "not-a-chord" }, "enter");
  assert.equal(invalid.send, "Enter");
  assert.deepEqual(resetComposerKeymapBinding({ send: "Mod+Enter", steer: "Alt+Enter" }, "send"), { steer: "Alt+Enter" });
});

test("conflicts name both actions and block rebinding to a taken chord", () => {
  const keymap = resolveComposerKeymap({}, "enter");
  assert.deepEqual(findComposerKeymapConflicts(keymap), []);
  assert.deepEqual(conflictingActions(keymap, "newline", "Enter"), ["send"]);
  assert.deepEqual(conflictingActions(keymap, "send", "Mod+Shift+Enter"), ["steer"]);
  assert.deepEqual(conflictingActions(keymap, "send", "Mod+J"), []);
  const duplicated = { ...keymap, togglePlan: "Enter" };
  assert.deepEqual(findComposerKeymapConflicts(duplicated), [{ chord: "Enter", actions: ["send", "togglePlan"] }]);
});

test("rebinding swaps a taken chord instead of blocking", () => {
  const keymap = resolveComposerKeymap({}, "enter");
  // Enter-to-send becomes Enter-to-break; the old send binding moves to newline.
  const swapped = rebindComposerKeymap({}, keymap, "send", "Shift+Enter");
  assert.deepEqual(swapped, { overrides: { send: "Shift+Enter", newline: "Enter" }, swapped: "newline" });
  const resolved = resolveComposerKeymap("overrides" in swapped ? swapped.overrides : {}, "enter");
  assert.equal(resolved.send, "Shift+Enter");
  assert.equal(resolved.newline, "Enter");
  // Two actions already sharing a chord cannot be swapped into a third binding.
  const duplicated = resolveComposerKeymap({ send: "Alt+Enter", steer: "Alt+Enter" }, "enter");
  assert.deepEqual(rebindComposerKeymap({}, duplicated, "newline", "Alt+Enter"), { conflict: ["send", "steer"] });
  // Unused chords just bind.
  assert.deepEqual(rebindComposerKeymap({}, keymap, "togglePlan", "Mod+J"), { overrides: { togglePlan: "Mod+J" } });
});

test("display labels stay readable in both locales", () => {
  assert.equal(formatShortcutChord("Mod+Shift+Enter"), "Ctrl / ⌘ + Shift + Enter");
  assert.equal(formatShortcutChord("Enter"), "Enter");
  assert.equal(formatShortcutChord("Mod+k"), "Ctrl / ⌘ + K");
  assert.equal(formatShortcutChord("Hyper+Enter"), "Hyper+Enter");
});
