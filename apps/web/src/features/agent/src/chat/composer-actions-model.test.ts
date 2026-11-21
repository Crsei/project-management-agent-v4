import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPOSER_DENSITY_LIMITS,
  collapsedComposerControls,
  isPlainTextDraft,
  resolveComposerDensity,
  resolveComposerPrimaryAction,
  type ComposerPrimaryInput,
} from "./composer-actions-model.ts";

const base: ComposerPrimaryInput = {
  running: false,
  remoteThread: true,
  hasText: true,
  attachmentCount: 0,
  hasQuote: false,
  selectionCount: 0,
  historyBlocked: false,
  tooLong: false,
  saveError: false,
  saving: false,
  sessionDisabled: false,
  sendUnavailable: false,
  steer: { supported: false },
  resumable: false,
};

test("idle composer submits text and explains every block", () => {
  assert.equal(resolveComposerPrimaryAction(base).kind, "submit");
  const blocked = resolveComposerPrimaryAction({ ...base, saveError: true });
  assert.equal(blocked.kind, "submit");
  assert.equal(blocked.disabled, true);
  assert.match(blocked.reason!.zh, /保存失败/);
  assert.match(resolveComposerPrimaryAction({ ...base, sendUnavailable: true }).reason!.en, /not available/i);
  assert.equal(resolveComposerPrimaryAction({ ...base, tooLong: true }).disabled, true);
});

test("an unfinished composer selection blocks sending with its own reason", () => {
  const blocked = resolveComposerPrimaryAction({ ...base, draftBlocked: true });
  assert.equal(blocked.kind, "submit");
  assert.equal(blocked.disabled, true);
  assert.match(blocked.reason!.en, /unfinished selection/i);
});

test("selected context only sends when the composer is otherwise empty", () => {
  const empty = { ...base, hasText: false, selectionCount: 2 };
  assert.equal(resolveComposerPrimaryAction(empty).kind, "send-context");
  assert.equal(resolveComposerPrimaryAction({ ...empty, hasText: true }).kind, "submit");
  assert.equal(resolveComposerPrimaryAction({ ...empty, selectionCount: 0 }).kind, "submit");
});

test("running turns queue plain text instead of steering implicitly", () => {
  const running = { ...base, running: true };
  assert.equal(resolveComposerPrimaryAction(running).kind, "queue");
  assert.equal(
    resolveComposerPrimaryAction({ ...running, steer: { supported: true, interruptsTools: false } }).kind,
    "queue",
  );
  assert.equal(
    resolveComposerPrimaryAction({ ...running, steer: { supported: true, interruptsTools: true } }).kind,
    "queue",
  );
});

test("running with attachments or references hides instead of inventing a queue", () => {
  const running = { ...base, running: true };
  assert.equal(resolveComposerPrimaryAction({ ...running, attachmentCount: 1 }).kind, "hidden");
  assert.equal(resolveComposerPrimaryAction({ ...running, selectionCount: 1 }).kind, "hidden");
  assert.equal(resolveComposerPrimaryAction({ ...running, hasQuote: true }).kind, "hidden");
  assert.equal(resolveComposerPrimaryAction({ ...running, hasText: false }).kind, "hidden");
  assert.equal(resolveComposerPrimaryAction({ ...running, remoteThread: false }).kind, "hidden");
  // Steer is text-only regardless of other draft parts.
  assert.equal(resolveComposerPrimaryAction({ ...running, hasText: false, steer: { supported: true } }).kind, "hidden");
});

test("resume only appears for a resumable generation and an empty composer", () => {
  const empty = { ...base, hasText: false, resumable: true };
  assert.equal(resolveComposerPrimaryAction(empty).kind, "resume");
  assert.equal(resolveComposerPrimaryAction({ ...empty, hasText: true }).kind, "submit");
  assert.equal(resolveComposerPrimaryAction({ ...empty, selectionCount: 1 }).kind, "send-context");
  assert.equal(resolveComposerPrimaryAction({ ...empty, remoteThread: false }).kind, "submit");
  assert.equal(resolveComposerPrimaryAction({ ...empty, historyBlocked: true }).disabled, true);
});

test("normal submit remains the primary action; explicit compaction is separate", () => {
  assert.equal(resolveComposerPrimaryAction(base).kind, "submit");
});

test("queue takes plain text only", () => {
  assert.equal(isPlainTextDraft(base), true);
  assert.equal(isPlainTextDraft({ ...base, attachmentCount: 1 }), false);
  assert.equal(isPlainTextDraft({ ...base, hasQuote: true }), false);
  assert.equal(isPlainTextDraft({ ...base, selectionCount: 1 }), false);
  assert.equal(isPlainTextDraft({ ...base, hasText: false }), false);
});

test("density buckets follow the measured container width", () => {
  assert.equal(resolveComposerDensity(undefined), "wide");
  assert.equal(resolveComposerDensity(Number.NaN), "wide");
  assert.equal(resolveComposerDensity(COMPOSER_DENSITY_LIMITS.compact), "wide");
  assert.equal(resolveComposerDensity(COMPOSER_DENSITY_LIMITS.compact - 1), "compact");
  assert.equal(resolveComposerDensity(COMPOSER_DENSITY_LIMITS.narrow), "compact");
  assert.equal(resolveComposerDensity(COMPOSER_DENSITY_LIMITS.narrow - 1), "narrow");
  assert.deepEqual(collapsedComposerControls("wide"), []);
  assert.deepEqual(collapsedComposerControls("compact"), ["traits", "contextMeter"]);
  assert.deepEqual(collapsedComposerControls("narrow"), ["traits", "contextActions", "contextMeter", "dictation", "attachment"]);
});
