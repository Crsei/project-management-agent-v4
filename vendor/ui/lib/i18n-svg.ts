"use client"
import { useMemo } from "react"
import { createTranslator, type MessageValues } from "./i18n-core"
import { useI18n } from "./i18n-provider"
import { svgMessages } from "./i18n-svg-messages"

export type SvgMessageKey = keyof (typeof svgMessages)["zh-CN"]
export type SvgUiMessage = { key: SvgMessageKey; values?: MessageValues }
export function svgUiMessage(
  key: SvgMessageKey,
  values?: MessageValues,
): SvgUiMessage {
  return { key, values }
}
/** Share the portable provider and typed translation contract without loading SVG text globally. */
export function useSvgI18n() {
  const base = useI18n()
  return useMemo(() => {
    const t = createTranslator(base.locale, svgMessages)
    return {
      ...base,
      t,
      resolve: (message: SvgUiMessage | undefined, fallback = "") =>
        message ? t(message.key, message.values) : fallback,
    }
  }, [base])
}
