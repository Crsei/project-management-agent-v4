"use client"

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  createTranslator,
  defaultLocale,
  isLocale,
  localizeBuiltIn,
  resolveUiMessage,
  type Locale,
  type UiMessage,
} from "./i18n-core"

type I18nContextValue = { locale: Locale; setLocale: (locale: Locale) => void }
const I18nContext = createContext<I18nContextValue>({
  locale: defaultLocale,
  setLocale: () => {},
})
export type I18nProviderProps = {
  children: ReactNode
  locale?: Locale
  defaultLocale?: Locale
  onLocaleChange?: (locale: Locale) => void
}

/** Scope-only provider: no storage, document, routing, network or application state. */
export function I18nProvider({
  children,
  locale: controlled,
  defaultLocale: initial = defaultLocale,
  onLocaleChange,
}: I18nProviderProps) {
  const [internal, setInternal] = useState<Locale>(initial)
  const locale = controlled ?? internal
  const setLocale = useCallback(
    (next: Locale) => {
      if (!isLocale(next) || next === locale) return
      if (controlled === undefined) setInternal(next)
      onLocaleChange?.(next)
    },
    [controlled, locale, onLocaleChange],
  )
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const context = useContext(I18nContext)
  return useMemo(
    () => ({
      ...context,
      t: createTranslator(context.locale),
      builtIn: (source: string) => localizeBuiltIn(context.locale, source),
      resolve: (message: UiMessage | undefined, fallback = "") =>
        resolveUiMessage(context.locale, message, fallback),
      number: (value: number, options?: Intl.NumberFormatOptions) =>
        new Intl.NumberFormat(context.locale, options).format(value),
      date: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat(context.locale, options).format(value),
    }),
    [context],
  )
}

/** Store descriptors for owned feedback; caller strings always remain literal. */
export function useUiFeedback(initial = "") {
  const [value, setValue] = useState<string | UiMessage>(initial)
  const { resolve } = useI18n()
  return [typeof value === "string" ? value : resolve(value), setValue] as const
}
