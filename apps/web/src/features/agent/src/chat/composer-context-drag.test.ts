import assert from "node:assert/strict";
import test from "node:test";
import { COMPOSER_CONTEXT_DRAG_TYPE, composerContextDragPayload, writeComposerContextDrag } from "./composer-context-drag.ts";
import { MESSAGE_CONTEXT_CLIPBOARD_TYPE } from "./message-context-clipboard.ts";

test("a dropped chip carries the same record shape the paste importer accepts", () => {
  assert.equal(COMPOSER_CONTEXT_DRAG_TYPE, MESSAGE_CONTEXT_CLIPBOARD_TYPE);
  const payload = composerContextDragPayload("selected text", [{
    type: "pm",
    reference: { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId: "PRJ-001", kind: "issue", id: "TASK-001", title: "Task", revision: "r1", availability: "unverified" },
  }]);
  const parsed = JSON.parse(payload) as { version: number; text: string; contexts: unknown[] };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.text, "selected text");
  assert.equal(parsed.contexts.length, 1);
});

test("the drag writer sets the payload and copies rather than moves", () => {
  const written: Record<string, string> = {};
  const dataTransfer: Pick<DataTransfer, "setData" | "effectAllowed"> = { effectAllowed: "none", setData: (type: string, value: string) => { written[type] = value; } };
  writeComposerContextDrag(dataTransfer, "{\"version\":1}");
  assert.equal(dataTransfer.effectAllowed, "copy");
  assert.equal(written[COMPOSER_CONTEXT_DRAG_TYPE], "{\"version\":1}");
});
