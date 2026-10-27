import { componentMessages } from "./i18n-messages.ts"

export const locales = ["zh-CN", "en"] as const
export type Locale = (typeof locales)[number]
export const defaultLocale: Locale = "zh-CN"
export type MessageValues = Record<string, string | number | UiMessage>
export type MessageValue = string | { one: string; other: string }
export type Messages = Record<Locale, Record<string, MessageValue>>
export type MessageKey = keyof (typeof componentMessages)["zh-CN"]
export type UiMessage = { key: MessageKey; values?: MessageValues }

export function isLocale(value: unknown): value is Locale {
  return value === "zh-CN" || value === "en"
}

export function createTranslator<M extends Messages = typeof componentMessages>(
  locale: Locale,
  messages: M = componentMessages as unknown as M,
) {
  return (
    key: keyof M["zh-CN"] & string,
    values: MessageValues = {},
  ): string => {
    const value = messages[locale][key] ?? messages[defaultLocale][key] ?? key
    const template =
      typeof value === "string"
        ? value
        : value[
            new Intl.PluralRules(locale).select(
              Number(values.count ?? values.value0 ?? 0),
            ) === "one"
              ? "one"
              : "other"
          ]
    return template.replace(/\{([\w]+)\}/g, (placeholder, name: string) =>
      Object.hasOwn(values, name)
        ? typeof values[name] === "object"
          ? resolveUiMessage(locale, values[name])
          : String(values[name])
        : placeholder,
    )
  }
}

export function uiMessage(key: MessageKey, values?: MessageValues): UiMessage {
  return { key, values }
}

export function resolveUiMessage(
  locale: Locale,
  message: UiMessage | undefined,
  fallback = "",
): string {
  return message
    ? createTranslator(locale)(message.key, message.values)
    : fallback
}

/** For library-owned static metadata only. Never apply to caller text or service errors. */
export function localizeBuiltIn(locale: Locale, source: string) {
  const key = sourceKeys.get(source.replace(/\s+/g, " ").trim())
  return key ? createTranslator(locale)(key) : source
}

const sourceKeys = new Map<string, MessageKey>(
  Object.entries(componentMessages[defaultLocale]).flatMap(([key, source]) =>
    typeof source === "string"
      ? [[source.replace(/\s+/g, " ").trim(), key as MessageKey] as const]
      : [],
  ),
)

/** Only pass library-owned presentation metadata, never document or caller data. */
export function localizeStaticData<T>(data: T, locale: Locale): T {
  if (typeof data === "string") return localizeBuiltIn(locale, data) as T
  if (Array.isArray(data))
    return data.map((value) => localizeStaticData(value, locale)) as T
  if (data && typeof data === "object" && !("$$typeof" in data)) {
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [
        key,
        localizeStaticData(value, locale),
      ]),
    ) as T
  }
  return data
}

export class UiError extends Error {
  readonly messageI18n: UiMessage
  constructor(key: MessageKey, values?: MessageValues) {
    super(createTranslator(defaultLocale)(key, values))
    this.name = "UiError"
    this.messageI18n = uiMessage(key, values)
  }
}

export type UiText = string | UiMessage
export function resolveUiText(
  locale: Locale,
  value: UiText | undefined,
): string {
  return typeof value === "string" ? value : resolveUiMessage(locale, value)
}
export function uiTextFields(value: UiText): {
  message: string
  messageI18n?: UiMessage
} {
  return {
    message: resolveUiText(defaultLocale, value),
    messageI18n: typeof value === "string" ? undefined : value,
  }
}
export function uiField<K extends string>(
  field: K,
  value: UiText | undefined,
): Record<K, string | undefined> & Partial<Record<`${K}I18n`, UiMessage>> {
  return {
    [field]:
      value === undefined ? undefined : resolveUiText(defaultLocale, value),
    [`${field}I18n`]: typeof value === "object" ? value : undefined,
  } as Record<K, string | undefined> & Partial<Record<`${K}I18n`, UiMessage>>
}
export function uiTextError(value: UiText): Error {
  return typeof value === "string"
    ? new Error(value)
    : new UiError(value.key, value.values)
}

/** Known library presentation metadata only. Caller content remains literal. */
export function builtInMessage(source: string): UiText {
  const key = sourceKeys.get(source.replace(/\s+/g, " ").trim())
  return key ? uiMessage(key) : source
}
