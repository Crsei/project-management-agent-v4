/** Matches the persisted draft message limit; the server remains authoritative. */
export const COMPOSER_PROMPT_LIMIT = 256_000;

export function composerPromptTooLong(text: string): boolean {
  return text.length > COMPOSER_PROMPT_LIMIT;
}
