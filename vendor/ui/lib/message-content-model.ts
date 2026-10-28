import type { CodeHighlighterPlugin, HighlightOptions } from "streamdown"
import {
  bundledLanguages,
  createJavaScriptRegexEngine,
  getSingletonHighlighter,
  type BundledLanguage,
  type Highlighter,
} from "shiki"

/** Default render bound for one message body; callers may lower or raise it. */
export const MESSAGE_CONTENT_DEFAULT_MAXIMUM = 32768
/** Hard ceiling applied to `maximum` before slicing. */
export const MESSAGE_CONTENT_HARD_MAXIMUM = 262144

/** Slice message text to the bounded window actually rendered. */
export function messageContentText(
  content: string,
  maximum: number = MESSAGE_CONTENT_DEFAULT_MAXIMUM,
): string {
  return content.slice(
    0,
    Math.max(0, Math.min(MESSAGE_CONTENT_HARD_MAXIMUM, maximum)),
  )
}

/**
 * Host-owned gate for markdown images: return the URL that may be requested,
 * or nothing to keep the reference as inert visible text. Without a resolver
 * no remote image source is ever fetched.
 */
export type MessageContentImages = {
  resolve?: (url: string) => string | null | undefined
}

const SAFE_LINK_PROTOCOLS: Record<string, true> = {
  "http:": true,
  "https:": true,
  "mailto:": true,
  "tel:": true,
}

/**
 * Allow-list URL transform for Streamdown: relative targets keep working,
 * a small safe protocol set keeps working, every other scheme is refused
 * so unsafe links end up without an address at all.
 */
export function messageContentUrlTransform(
  url: string,
  key: string,
): string | null {
  const value = url.trim()
  if (!value) return null
  if (key !== "href") return value
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1].toLowerCase()
  if (!scheme) return value
  return SAFE_LINK_PROTOCOLS[`${scheme}:`] ? value : null
}

/** A resolved image source must be a request the host already approved. */
export function isDrawableImageUrl(url: string): boolean {
  const value = url.trim()
  if (!value) return false
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1].toLowerCase()
  if (!scheme) return true
  return (
    scheme === "http" ||
    scheme === "https" ||
    scheme === "blob" ||
    (scheme === "data" && value.toLowerCase().startsWith("data:image/"))
  )
}

const SHIKI_THEMES = ["github-light", "github-dark"] as const

/** One token in a highlighted code run, as Streamdown consumes it. */
type MessageCodeToken = {
  content: string
  color?: string
  bgColor?: string
  htmlStyle?: Record<string, string>
  offset?: number
}

/** One highlighted code block, as Streamdown consumes it. */
type MessageCodeHighlight = {
  bg?: string
  fg?: string
  rootStyle?: string | false
  tokens: MessageCodeToken[][]
}

let highlighterPromise: Promise<Highlighter> | null = null
let readyHighlighter: Highlighter | null = null
let supportedLanguages: BundledLanguage[] | null = null
const languageLoads = new Map<string, Promise<Highlighter>>()

function ensureLanguage(id: string): Promise<Highlighter> {
  const existing = languageLoads.get(id)
  if (existing) return existing
  const load = ensureHighlighter()
    .then(async (highlighter) => {
      if (!highlighter.getLoadedLanguages().includes(id)) {
        await highlighter.loadLanguage(id as BundledLanguage)
      }
      return highlighter
    })
    .catch((error: unknown) => {
      languageLoads.delete(id)
      throw error
    })
  languageLoads.set(id, load)
  return load
}

function ensureHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= getSingletonHighlighter({
    themes: [...SHIKI_THEMES],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  }).then((highlighter) => {
    readyHighlighter = highlighter
    return highlighter
  })
  return highlighterPromise
}

/** Tokens without colors: the real plain-code fallback for unknown languages. */
function plainHighlight(code: string): MessageCodeHighlight {
  return {
    bg: "transparent",
    fg: "inherit",
    rootStyle: false,
    tokens: code
      .replace(/\n+$/, "")
      .split("\n")
      .map((line) => [
        {
          content: line,
          color: "inherit",
          bgColor: "transparent",
          htmlStyle: {},
          offset: 0,
        },
      ]),
  }
}

function coloredHighlight(
  highlighter: Highlighter,
  options: HighlightOptions,
  id: string,
): MessageCodeHighlight {
  // Callers gate the identifier on bundledLanguages before reaching here.
  const lang = id as BundledLanguage
  const tokens = highlighter.codeToTokens(options.code, {
    lang,
    themes: { light: options.themes[0], dark: options.themes[1] },
    defaultColor: false,
  })
  // Shiki's ThemedToken is structurally wider than the token view Streamdown reads.
  const mappedTokens = tokens.tokens as unknown as MessageCodeToken[][]
  return {
    bg: tokens.bg,
    fg: tokens.fg,
    rootStyle: tokens.rootStyle ?? false,
    tokens: mappedTokens,
  }
}

/**
 * Shiki-backed Streamdown code plugin using the installed root `shiki`.
 * Unknown fence languages return real plain tokens immediately; known
 * languages highlight synchronously once ready and through the callback
 * while a grammar is still loading, so streamed text never goes stale.
 */
export const messageContentCodePlugin: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getThemes: () => [...SHIKI_THEMES],
  getSupportedLanguages: () =>
    (supportedLanguages ??= Object.keys(bundledLanguages) as BundledLanguage[]),
  supportsLanguage: (language) =>
    Object.hasOwn(
      bundledLanguages,
      String(language).trim().toLowerCase().split(/\s+/)[0] ?? "",
    ),
  highlight: (options, callback) => {
    const id =
      String(options.language ?? "")
        .trim()
        .toLowerCase()
        .split(/\s+/)[0] ?? ""
    if (!id || !Object.hasOwn(bundledLanguages, id))
      return plainHighlight(options.code)
    const ready = readyHighlighter
    if (ready?.getLoadedLanguages().includes(id)) {
      return coloredHighlight(ready, options, id)
    }
    ensureLanguage(id).then(
      (highlighter) => callback?.(coloredHighlight(highlighter, options, id)),
      () => callback?.(plainHighlight(options.code)),
    )
    return null
  },
}
