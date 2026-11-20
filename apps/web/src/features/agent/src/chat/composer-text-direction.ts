// Adapted from t3code composer-text-direction.ts (d53873b6). Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
export type TextDirection = "ltr" | "rtl";

// Hebrew through Arabic Extended-A, their presentation forms, and the supplementary right-to-left blocks.
const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const LETTER = /\p{L}/u;

/**
 * The base direction for a block of prose, or undefined when it has no letters.
 *
 * `dir="auto"` follows the first letter, which lays out an Arabic line that
 * opens with an English term (`StrictMode: يعيد الـ render مرتين`) left to
 * right. Counting words keeps such a line right to left, while English with a
 * quoted Arabic word stays left to right. A tie goes to the first word.
 */
export function textDirection(text: string): TextDirection | undefined {
  let rtlWords = 0;
  let ltrWords = 0;
  let first: TextDirection | undefined;
  for (const word of text.split(/\s+/u)) {
    const letter = LETTER.exec(word)?.[0];
    if (!letter) continue;
    const direction = RTL_LETTER.test(letter) ? "rtl" : "ltr";
    first ??= direction;
    if (direction === "rtl") rtlWords += 1;
    else ltrWords += 1;
  }
  if (rtlWords === ltrWords) return first;
  return rtlWords > ltrWords ? "rtl" : "ltr";
}

/**
 * One direction per top-level block. A block without letters continues the one
 * above, so a new line after Arabic starts on the right. Code stays left to right.
 * Inline code is masked with spaces by the editor before this call, because a
 * Latin identifier must not decide an Arabic line's direction.
 */
export function resolveBlockDirections(blocks: readonly { text: string; code?: boolean }[]): Array<TextDirection | null> {
  const directions: Array<TextDirection | null> = [];
  let previous: TextDirection | null = null;
  for (const block of blocks) {
    if (block.code) {
      directions.push("ltr");
      continue;
    }
    const direction: TextDirection | null = textDirection(block.text) ?? previous;
    directions.push(direction);
    previous = direction;
  }
  return directions;
}
