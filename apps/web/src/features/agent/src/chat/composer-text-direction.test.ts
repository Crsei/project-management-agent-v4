import assert from "node:assert/strict";
import test from "node:test";
import { resolveBlockDirections, textDirection } from "./composer-text-direction.ts";

test("direction follows the first strong word only for ties", () => {
  assert.equal(textDirection("plain English"), "ltr");
  assert.equal(textDirection("اكتب الدالة"), "rtl");
  assert.equal(textDirection("StrictMode: يعيد الـ render مرتين"), "rtl");
  assert.equal(textDirection("Use the word «مرحبا» in a sentence"), "ltr");
  assert.equal(textDirection("42 —— !!"), undefined);
});

test("inline code is masked before measuring, so identifiers do not decide the line", () => {
  // The editor replaces every inline `<code>` with a space: this line keeps only «و في».
  assert.equal(textDirection("       و         في      "), "rtl");
  assert.equal(textDirection("useEffect و useLayoutEffect في React"), "ltr");
});

test("each block gets its own direction, code stays left to right", () => {
  assert.deepEqual(resolveBlockDirections([{ text: "اكتب الدالة" }, { text: "42" }, { text: "fix it" }]), ["rtl", "rtl", "ltr"]);
  assert.deepEqual(resolveBlockDirections([{ text: "first" }, { text: "اكتب" }]), ["ltr", "rtl"]);
  assert.deepEqual(resolveBlockDirections([{ text: "اكتب", code: true }, { text: "ثم اختبرها" }]), ["ltr", "rtl"]);
  assert.deepEqual(resolveBlockDirections([{ text: "" }, { text: "after empty" }]), [null, "ltr"]);
});

test("an Arabic list is one right-to-left block regardless of item order", () => {
  assert.equal(textDirection("Vitest\nاختبر الدالة الجديدة\nوأضف تعليق"), "rtl");
});
