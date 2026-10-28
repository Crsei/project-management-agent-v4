import type { ApScenario } from "../model"
export const tokenizerExamples = [
  {
    id: "support",
    label: "Support prompt",
    text: "You are a helpful support assistant. Answer the customer’s question using the provided knowledge base. If you’re unsure, ask a clarifying question.\n\nCustomer: How do I invite my team to a workspace?",
  },
  {
    id: "code",
    label: "Code",
    text: 'function greet(name: string) {\n  return `Hello, ${name}!`;\n}\n\nconsole.log(greet("world"));',
  },
  {
    id: "multilingual",
    label: "Multilingual",
    text: "Hello, world! Bonjour le monde ! नमस्ते दुनिया! こんにちは世界 🌍\nLanguage connects us.",
  },
  {
    id: "structured",
    label: "Structured data",
    text: '{\n  "project": "Support copilot",\n  "enabled": true,\n  "tools": ["file_search", "create_ticket"],\n  "max_turns": 12\n}',
  },
] as const
export const tokenizerLimits = {
  text: 20_000,
  idsText: 80_000,
  ids: 10_000,
} as const
export const tokenizerVersion = "gpt-tokenizer@4.0.0"
export type TokenizerMode = "encode" | "decode"
export type TokenizerEncoding = "o200k_base" | "cl100k_base"
export type TokenizerOutput = "text" | "ids" | "json"
export type TokenizerState = {
  text: string
  ids: string
  idsInitialized: boolean
  mode: TokenizerMode
  encoding: TokenizerEncoding
  output: TokenizerOutput
  example: string
  whitespace: boolean
  budget: string
  selected: number
  fault: "none" | "loading" | "refresh-error" | "missing-data"
  selection: Record<
    TokenizerMode,
    { start: number; end: number; scrollTop: number }
  >
}
export function createTokenizerState(scenario: ApScenario): TokenizerState {
  return {
    text:
      scenario === "empty"
        ? ""
        : scenario === "long-content"
          ? tokenizerExamples[2].text.repeat(200)
          : tokenizerExamples[0].text,
    ids: "",
    idsInitialized: false,
    mode: "encode",
    encoding: "o200k_base",
    output: "text",
    example: "support",
    whitespace: false,
    budget: "4096",
    selected: 0,
    fault:
      scenario === "loading" ||
      scenario === "refresh-error" ||
      scenario === "missing-data"
        ? scenario
        : "none",
    selection: {
      encode: { start: 0, end: 0, scrollTop: 0 },
      decode: { start: 0, end: 0, scrollTop: 0 },
    },
  }
}
