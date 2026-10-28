import { parseSvg } from "./svg-workbench-parse"
import { serializeSvg, svgToTsx, type SvgDocument } from "./svg-workbench-model"
export type SvgTaskInput =
  | { type: "parse"; text: string }
  | { type: "optimize" | "tsx"; document: SvgDocument }
export async function runSvgTask(input: SvgTaskInput) {
  if (input.type === "parse") return parseSvg(input.text)
  const validated = parseSvg(serializeSvg(input.document))
  if (!validated.document) return validated
  if (input.type === "tsx")
    return { code: svgToTsx(input.document), diagnostics: [] }
  const { optimize } = await import("svgo/browser")
  // Deliberately conservative: preserve viewBox, titles, descriptions, IDs and geometry.
  const optimized = optimize(serializeSvg(input.document), {
    plugins: ["removeComments", "removeMetadata", "removeXMLNS", "sortAttrs"],
  }).data
  const parsed = parseSvg(optimized)
  if (parsed.document)
    parsed.document.sources = input.document.sources.map((s) => ({
      ...s,
      modified: true,
    }))
  return { ...parsed, code: optimized }
}
const scope = globalThis as unknown as {
  postMessage: (data: unknown) => void
  onmessage: ((event: MessageEvent<SvgTaskInput>) => void) | null
  document?: unknown
}
if (typeof scope.postMessage === "function" && !scope.document)
  scope.onmessage = async (event) => {
    try {
      scope.postMessage(await runSvgTask(event.data))
    } catch (e) {
      scope.postMessage({
        diagnostics: [
          { code: "xml", detail: e instanceof Error ? e.message : String(e) },
        ],
      })
    }
  }
