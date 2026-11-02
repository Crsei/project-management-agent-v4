// Pure text inspection. Source text is data, never an instruction or an execution request.
export const DAY_MS = 86_400_000;
export const normalized = (text: string): string => text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
export function similarity(left: string, right: string): number {
  const a = normalized(left); const b = normalized(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (value: string) => new Set(Array.from({ length: Math.max(0, value.length - 1) }, (_, i) => value.slice(i, i + 2)));
  const x = grams(a); const y = grams(b);
  return x.size && y.size ? 2 * [...x].filter(value => y.has(value)).length / (x.size + y.size) : 0;
}
export function time(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
}
export function pathAllowed(file: string, allowed: string): boolean {
  if (!file || !allowed || file.startsWith('/') || allowed.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(file + '/' + allowed)) return false;
  if (allowed.endsWith('/**')) return file.startsWith(allowed.slice(0, -2));
  if (allowed.endsWith('/*')) return file.startsWith(allowed.slice(0, -1));
  return file === allowed || file.startsWith(allowed.endsWith('/') ? allowed : `${allowed}/`);
}
export function declaredPaths(text: string): string[] {
  return [...new Set(text.split('\n').filter(line => /(?:允许|目标|预期|范围|expected|allowed)[^：:\n]*(?:文件|路径|files?|paths?)\s*[：:]|(?:expected|allowed)\s+files?\s*:/i.test(line))
    .flatMap(line => line.replace(/^[^：:]*[：:]\s*/, '').split(/[,，;；\s]+/).map(path => path.replace(/[`。]/g, '').replace(/^\.\//, '')).filter(path => path.includes('/') && pathAllowed(path.replace(/\/\*\*?$/, '/probe'), path))))].sort();
}
export type TextMessage = { id: string; text: string; at?: string };
/** Only explicit pending markers count, with subsequent explicit withdrawals respected. */
export function unresolvedMessages<T extends TextMessage>(messages: readonly T[]): Array<T & { excerpt: string }> {
  let pending: Array<T & { excerpt: string }> = [];
  const chronological = messages.every(message => time(message.at) !== undefined) ? [...messages].sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!)) : messages;
  for (const message of chronological) {
    for (const line of message.text.split('\n').map(value => value.trim()).filter(Boolean)) {
      if (/(?:所有|全部|上述).*(?:待办|遗留|TODO).*(?:已完成|已解决|已处理)|^all\s+(?:todos?|follow.?ups?)\s+(?:resolved|done)/i.test(line)) { pending = []; continue; }
      const resolved = line.match(/^(?:已完成|已解决|已处理|resolved|done)\s*[：:]\s*(.+)/i)?.[1];
      if (resolved) {
        const subject = normalized(resolved);
        pending = pending.filter(item => {
          const previous = normalized(item.excerpt.replace(/^(?:待办|待解决|未解决|TODO|unresolved)\s*[：:]?\s*/i, ''));
          return !(previous === subject || similarity(previous, subject) >= 0.9);
        });
        continue;
      }
      if (!/^(?:[-*]\s*)?(?:待办|待解决|未解决|后续需|需要补|TODO\b|仍需|尚未|还需|unresolved\b|follow.?up\s*:)/i.test(line)) continue;
      if (/(?:没有|无)(?:未解决|待办|遗留)|\bno\s+(?:todos?|unresolved)\b/i.test(line)) continue;
      pending = pending.filter(item => normalized(item.excerpt) !== normalized(line));
      pending.push({ ...message, excerpt: line });
    }
  }
  return pending;
}
export function decisionLines<T extends TextMessage>(messages: readonly T[]): Array<T & { excerpt: string }> {
  return messages.flatMap(message => message.text.split('\n').map(line => line.trim()).filter(line => /^(?:决策[：:]|决定采用|我们决定|decision\s*:|we decided\b)/i.test(line)).map(excerpt => ({ ...message, excerpt })));
}
export function topicLines<T extends TextMessage>(messages: readonly T[]): Array<T & { topic: string; excerpt: string }> {
  return messages.flatMap(message => message.text.split('\n').flatMap(line => {
    const topic = line.match(/^(?:技术主题|主题|topic)\s*[：:]\s*([^。；;\n]+)/i)?.[1]?.trim();
    return topic ? [{ ...message, topic, excerpt: line.trim() }] : [];
  }));
}
export const errorSignature = (line: string): string => normalized(line.replace(/^\[[^\]]+\]\s*/, ''));
