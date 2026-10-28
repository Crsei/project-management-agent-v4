import { tokenizerLimits, tokenizerVersion } from "./fixtures.ts"
import type { TokenizerEncoding, TokenizerMode } from "./fixtures.ts"
export type TokenPiece = {
  text: string
  ids: number[]
  bytes: number[]
  position: number
}
export type TokenAnalysis = {
  encoding: TokenizerEncoding
  version: string
  text: string
  tokens: number[]
  tokenCount: number
  characterCount: number
  charsPerToken: number | null
  pieces: TokenPiece[]
}
export type TokenErrorCode =
  "text-limit" | "ids-limit" | "ids-format" | "invalid-id" | "engine"
export type TokenFailure = {
  code: TokenErrorCode
  id?: number
  position?: number
}
export type TokenRequest = {
  operationId: number
  encoding: TokenizerEncoding
  mode: TokenizerMode
  input: string
}
export type TokenResponse =
  | { operationId: number; result: TokenAnalysis }
  | { operationId: number; error: TokenFailure }
export class TokenInputError extends Error {
  readonly failure: TokenFailure
  constructor(failure: TokenFailure) {
    super(failure.code)
    this.failure = failure
  }
}
export function parseTokenIds(input: string): number[] {
  if (input.length > tokenizerLimits.idsText)
    throw new TokenInputError({ code: "ids-limit" })
  const trimmed = input.trim()
  if (!trimmed) return []
  let values: unknown
  if (trimmed.startsWith("[")) {
    try {
      values = JSON.parse(trimmed)
    } catch {
      throw new TokenInputError({ code: "ids-format" })
    }
  } else {
    const parts = trimmed.split(",")
    if (parts.some((part) => !/^\d+$/.test(part.trim())))
      throw new TokenInputError({ code: "ids-format" })
    values = parts.map(Number)
  }
  if (
    !Array.isArray(values) ||
    values.some(
      (value) =>
        typeof value !== "number" || !Number.isSafeInteger(value) || value < 0,
    )
  )
    throw new TokenInputError({ code: "ids-format" })
  if (values.length > tokenizerLimits.ids)
    throw new TokenInputError({ code: "ids-limit" })
  return values as number[]
}
type Rank = string | readonly number[]
type Encoder = {
  encode: (
    text: string,
    options: { disallowedSpecial: Set<string> },
  ) => number[]
  ranks: readonly Rank[]
  specials: Map<number, string>
}
const encoders = new Map<TokenizerEncoding, Promise<Encoder>>()
function loadEncoder(encoding: TokenizerEncoding) {
  let pending = encoders.get(encoding)
  if (!pending) {
    pending =
      encoding === "o200k_base"
        ? Promise.all([
            import("gpt-tokenizer/encoding/o200k_base"),
            import("gpt-tokenizer/bpeRanks/o200k_base"),
            import("gpt-tokenizer/encodingParams/o200k_base"),
          ]).then(([api, data, params]) => ({
            encode: api.encode,
            ranks: data.default,
            specials: new Map(
              [...params.O200KBase(data.default).specialTokensEncoder].map(
                ([text, id]) => [id, text],
              ),
            ),
          }))
        : Promise.all([
            import("gpt-tokenizer/encoding/cl100k_base"),
            import("gpt-tokenizer/bpeRanks/cl100k_base"),
            import("gpt-tokenizer/encodingParams/cl100k_base"),
          ]).then(([api, data, params]) => ({
            encode: api.encode,
            ranks: data.default,
            specials: new Map(
              [...params.Cl100KBase(data.default).specialTokensEncoder].map(
                ([text, id]) => [id, text],
              ),
            ),
          }))
    encoders.set(encoding, pending)
    pending.catch(() => encoders.delete(encoding))
  }
  return pending
}
/** Byte sequences are read from the encoder's public vocabulary, never reconstructed from lossy single-token decoding. */
export function groupTokenBytes(
  tokens: readonly number[],
  ranks: readonly Rank[],
  specials: ReadonlyMap<number, string>,
): TokenPiece[] {
  const encoder = new TextEncoder(),
    decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }),
    fallback = new TextDecoder("utf-8", { ignoreBOM: true })
  const pieces: TokenPiece[] = []
  let bytes: number[] = [],
    ids: number[] = [],
    position = 0
  function flush(text: string) {
    pieces.push({ text, ids, bytes, position })
    position += ids.length
    bytes = []
    ids = []
  }
  for (const [index, id] of tokens.entries()) {
    const rank = ranks[id] ?? specials.get(id)
    if (rank === undefined)
      throw new TokenInputError({ code: "invalid-id", id, position: index + 1 })
    const raw = typeof rank === "string" ? encoder.encode(rank) : rank
    for (const byte of raw) bytes.push(byte)
    ids.push(id)
    try {
      flush(decoder.decode(new Uint8Array(bytes)))
    } catch {
      /* Wait for the remainder of a UTF-8 piece. */
    }
  }
  if (ids.length) flush(fallback.decode(new Uint8Array(bytes)))
  return pieces
}
export async function analyzeTokens(
  request: Omit<TokenRequest, "operationId">,
): Promise<TokenAnalysis> {
  if (request.mode === "encode" && request.input.length > tokenizerLimits.text)
    throw new TokenInputError({ code: "text-limit" })
  const parsed = request.mode === "decode" ? parseTokenIds(request.input) : null
  const api = await loadEncoder(request.encoding)
  const tokens =
    parsed ??
    api.encode(request.input, { disallowedSpecial: new Set<string>() })
  const pieces = groupTokenBytes(tokens, api.ranks, api.specials)
  const text = pieces.map((piece) => piece.text).join("")
  let characterCount = 0
  for (const point of text) characterCount += point.length > 0 ? 1 : 0
  return {
    encoding: request.encoding,
    version: tokenizerVersion,
    text,
    tokens,
    tokenCount: tokens.length,
    characterCount,
    charsPerToken: tokens.length ? characterCount / tokens.length : null,
    pieces,
  }
}
export function analysisJson(result: TokenAnalysis) {
  return JSON.stringify(
    {
      encoding: result.encoding,
      version: result.version,
      text: result.text,
      tokens: result.tokens,
      token_count: result.tokenCount,
      character_count: result.characterCount,
    },
    null,
    2,
  )
}
export function tokenIdsJson(result: TokenAnalysis) {
  return JSON.stringify(result.tokens)
}
export function showWhitespace(text: string) {
  return text
    .replace(/ /g, "·")
    .replace(/\t/g, "→")
    .replace(/\r/g, "␍")
    .replace(/\n/g, "↵\n")
}
export function validBudget(value: string) {
  return (
    /^\d+$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0 &&
    Number(value) <= 10_000_000
  )
}
