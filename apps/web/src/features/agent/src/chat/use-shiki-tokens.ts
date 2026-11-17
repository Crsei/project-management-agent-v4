import { useEffect, useState } from "react";
import type { ThemedTokenWithVariants } from "shiki";

type Result = { code: string; language: string; tokens: ThemedTokenWithVariants[][] };

/** Lazily tokenize provider text; unsupported or failed grammars stay literal. */
export function useShikiTokens(code: string, language: string, streaming = false): ThemedTokenWithVariants[][] | null {
  const [result, setResult] = useState<Result | null>(null);
  useEffect(() => {
    if (!language || language === "mermaid" || code.length > 100_000) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void import("shiki").then(async ({ bundledLanguages, bundledLanguagesAlias, codeToTokensWithThemes }) => {
        if (!current || (!Object.hasOwn(bundledLanguages, language) && !Object.hasOwn(bundledLanguagesAlias, language))) return;
        const tokens = await codeToTokensWithThemes(code, { lang: language as keyof typeof bundledLanguages, themes: { light: "github-light", dark: "github-dark" }, tokenizeMaxLineLength: 10_000, tokenizeTimeLimit: 100 });
        if (current) setResult({ code, language, tokens });
      }).catch(() => { /* Literal fallback only; never inject HTML. */ });
    }, streaming ? 120 : 0);
    return () => { current = false; window.clearTimeout(timer); };
  }, [code, language, streaming]);
  return result?.code === code && result.language === language ? result.tokens : null;
}
