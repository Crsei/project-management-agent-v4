import {
  SVG_LIMITS,
  type SvgDocument,
  type SvgDiagnostic,
} from "./svg-workbench-model"
import type { SvgTaskInput } from "./svg-workbench-worker"
export type SvgTaskResult = {
  document?: SvgDocument
  diagnostics: SvgDiagnostic[]
  code?: string
}
/** Each operation has a private worker so abort/timeout can terminate synchronous parsing. */
export function svgWorkbenchTask(
  input: SvgTaskInput,
  signal: AbortSignal,
  timeoutMs: number = SVG_LIMITS.timeoutMs,
): Promise<SvgTaskResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Cancelled", "AbortError"))
      return
    }
    const worker = new Worker(
      new URL("./svg-workbench-worker.ts", import.meta.url),
      { type: "module" },
    )
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      worker.terminate()
    }
    const abort = () => {
      finish()
      reject(new DOMException("Cancelled", "AbortError"))
    }
    const timer = setTimeout(() => {
      finish()
      resolve({ diagnostics: [{ code: "timeout", detail: `${timeoutMs} ms` }] })
    }, timeoutMs)
    signal.addEventListener("abort", abort, { once: true })
    worker.onmessage = (e) => {
      finish()
      resolve(e.data as SvgTaskResult)
    }
    worker.onerror = (e) => {
      finish()
      resolve({ diagnostics: [{ code: "xml", detail: e.message }] })
    }
    worker.postMessage(input)
  })
}
