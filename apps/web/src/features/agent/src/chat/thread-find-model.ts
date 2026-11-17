export type FindRange = { textIndex: number; start: number; end: number };

/** Case-insensitive, non-overlapping literal matches limited per query. */
export function findMatchRanges(texts: readonly string[], query: string, limit = 500): FindRange[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const ranges: FindRange[] = [];
  for (let textIndex = 0; textIndex < texts.length && ranges.length < limit; textIndex++) {
    const haystack = texts[textIndex]!.toLocaleLowerCase();
    let from = 0;
    while (ranges.length < limit) {
      const start = haystack.indexOf(needle, from);
      if (start < 0) break;
      ranges.push({ textIndex, start, end: start + needle.length });
      from = start + Math.max(1, needle.length);
    }
  }
  return ranges;
}

/** Wrap-around navigation keeps Enter/Shift+Enter predictable at both ends. */
export function nextMatchIndex(index: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  if (index < 0) return delta > 0 ? 0 : count - 1;
  return (index + delta + count) % count;
}
