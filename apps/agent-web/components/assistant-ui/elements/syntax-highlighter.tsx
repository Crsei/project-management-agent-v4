"use client";

import { PrismAsyncLight } from "react-syntax-highlighter";
import { makePrismAsyncLightSyntaxHighlighter } from "@assistant-ui/react-syntax-highlighter";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";

import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import { coldarkCold, coldarkDark } from "react-syntax-highlighter/dist/cjs/styles/prism";

PrismAsyncLight.registerLanguage("js", tsx);
PrismAsyncLight.registerLanguage("jsx", tsx);
PrismAsyncLight.registerLanguage("ts", tsx);
PrismAsyncLight.registerLanguage("tsx", tsx);
PrismAsyncLight.registerLanguage("python", python);
PrismAsyncLight.registerLanguage("json", json);
PrismAsyncLight.registerLanguage("bash", bash);
PrismAsyncLight.registerLanguage("sh", bash);
PrismAsyncLight.registerLanguage("shell", bash);

const syntaxHighlighterCustomStyle = {
  // Unset so the markdown Pre's theme surface shows instead of the Prism theme's own background.
  background: undefined,
  margin: 0,
  width: "100%",
  padding: "1.5rem 1rem",
};

const LightSyntaxHighlighter = makePrismAsyncLightSyntaxHighlighter({
  style: coldarkCold,
  customStyle: syntaxHighlighterCustomStyle,
  className: "dark:hidden",
});

const DarkSyntaxHighlighter = makePrismAsyncLightSyntaxHighlighter({
  style: coldarkDark,
  customStyle: syntaxHighlighterCustomStyle,
  className: "hidden dark:block",
});

export const SyntaxHighlighter = (props: SyntaxHighlighterProps) => (
  <>
    <LightSyntaxHighlighter {...props} />
    <DarkSyntaxHighlighter {...props} />
  </>
);
