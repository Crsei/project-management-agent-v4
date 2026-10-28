/** Bounded portable context is evidence, not an instruction to replay old requests. */
export const PORTABLE_CONTEXT_CHARS = 32_000;
export function boundedContext(parts: string[], budget = PORTABLE_CONTEXT_CHARS): string {
  const chunks: string[] = [];
  let remaining = budget;
  for (let index = parts.length - 1; index >= 0 && remaining > 0; index--) {
    const part = parts[index];
    const text =
      part.length > remaining
        ? `[较早内容已截断]\n${part.slice(-Math.max(0, remaining - 20))}`
        : part;
    chunks.unshift(text);
    remaining -= text.length + 2;
  }
  return chunks.join("\n\n").slice(-budget);
}
