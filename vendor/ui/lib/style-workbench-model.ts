import { UiError } from "./i18n-core"
export const styleSections = [
  { id: "geometry", label: "尺寸与间距" },
  { id: "shadow", label: "阴影" },
  { id: "surface", label: "颜色与材质" },
  { id: "typography", label: "字体" },
] as const
export type StyleSection = (typeof styleSections)[number]["id"]

export const numericStyleControls = [
  {
    key: "radius",
    label: "圆角",
    unit: "px",
    min: 0,
    max: 48,
    step: 1,
    section: "geometry",
  },
  {
    key: "controlHeight",
    label: "控件高度",
    unit: "px",
    min: 24,
    max: 56,
    step: 4,
    section: "geometry",
  },
  {
    key: "padding",
    label: "内边距",
    unit: "px",
    min: 0,
    max: 48,
    step: 4,
    section: "geometry",
  },
  {
    key: "gap",
    label: "元素间距",
    unit: "px",
    min: 0,
    max: 32,
    step: 4,
    section: "geometry",
  },
  {
    key: "borderWidth",
    label: "边框宽度",
    unit: "px",
    min: 0,
    max: 4,
    step: 1,
    section: "geometry",
  },
  {
    key: "shadowX",
    label: "水平偏移",
    unit: "px",
    min: -40,
    max: 40,
    step: 1,
    section: "shadow",
  },
  {
    key: "shadowY",
    label: "垂直偏移",
    unit: "px",
    min: -40,
    max: 64,
    step: 1,
    section: "shadow",
  },
  {
    key: "shadowBlur",
    label: "模糊半径",
    unit: "px",
    min: 0,
    max: 80,
    step: 1,
    section: "shadow",
  },
  {
    key: "shadowSpread",
    label: "扩散范围",
    unit: "px",
    min: -24,
    max: 24,
    step: 1,
    section: "shadow",
  },
  {
    key: "shadowOpacity",
    label: "阴影不透明度",
    unit: "%",
    min: 0,
    max: 100,
    step: 1,
    section: "shadow",
  },
  {
    key: "borderOpacity",
    label: "边框不透明度",
    unit: "%",
    min: 0,
    max: 100,
    step: 1,
    section: "surface",
  },
  {
    key: "surfaceOpacity",
    label: "表面不透明度",
    unit: "%",
    min: 0,
    max: 100,
    step: 1,
    section: "surface",
  },
  {
    key: "textOpacity",
    label: "正文不透明度",
    unit: "%",
    min: 0,
    max: 100,
    step: 1,
    section: "surface",
  },
  {
    key: "backdropBlur",
    label: "背景模糊",
    unit: "px",
    min: 0,
    max: 32,
    step: 1,
    section: "surface",
  },
  {
    key: "fontSize",
    label: "字号",
    unit: "px",
    min: 12,
    max: 24,
    step: 1,
    section: "typography",
  },
  {
    key: "lineHeight",
    label: "行高",
    unit: "px",
    min: 16,
    max: 40,
    step: 1,
    section: "typography",
  },
  {
    key: "fontWeight",
    label: "字重",
    unit: "",
    min: 400,
    max: 600,
    step: 100,
    section: "typography",
  },
] as const
export type NumericStyleKey = (typeof numericStyleControls)[number]["key"]
export type NumericStyleControl = (typeof numericStyleControls)[number]
export const colorStyleControls = [
  { key: "surfaceColor", label: "表面颜色", section: "surface" },
  { key: "textColor", label: "正文颜色", section: "surface" },
  { key: "accentColor", label: "强调颜色", section: "surface" },
  { key: "borderColor", label: "边框颜色", section: "surface" },
  { key: "shadowColor", label: "阴影颜色", section: "shadow" },
] as const
export type ColorStyleKey = (typeof colorStyleControls)[number]["key"]
export type StyleValues = Record<NumericStyleKey, number> &
  Record<ColorStyleKey, string> & {
    shadowEnabled: boolean
    shadowInset: boolean
  }
export type StyleKey = keyof StyleValues

// Experimental presets, not additional product tokens or runtime statuses.
export const stylePresets: {
  id: string
  name: string
  section: StyleSection
  values: Partial<StyleValues>
}[] = [
  {
    id: "soft",
    name: "柔和浮层",
    section: "shadow",
    values: {
      radius: 12,
      padding: 20,
      gap: 12,
      shadowEnabled: true,
      shadowInset: false,
      shadowY: 12,
      shadowBlur: 40,
      shadowSpread: -4,
      shadowOpacity: 18,
    },
  },
  {
    id: "inset",
    name: "内凹表面",
    section: "shadow",
    values: {
      shadowEnabled: true,
      shadowInset: true,
      shadowX: 0,
      shadowY: 2,
      shadowBlur: 8,
      shadowSpread: 0,
      shadowOpacity: 20,
    },
  },
  {
    id: "pill",
    name: "胶囊控件",
    section: "geometry",
    values: { radius: 24, controlHeight: 32, shadowEnabled: false },
  },
  {
    id: "compact",
    name: "紧凑平面",
    section: "geometry",
    values: {
      radius: 6,
      controlHeight: 28,
      padding: 12,
      gap: 8,
      fontSize: 13,
      lineHeight: 20,
      shadowEnabled: false,
    },
  },
]

function rounded(value: number) {
  return Math.round(value * 100) / 100
}
export function clampStyleNumber(value: number, control: NumericStyleControl) {
  return rounded(
    Math.min(
      control.max,
      Math.max(
        control.min,
        control.min +
          Math.round((value - control.min) / control.step) * control.step,
      ),
    ),
  )
}
export function parseStyleColor(value: string) {
  const hex = value.trim().match(/^#([\da-f]{6})$/i)
  if (hex) return { hex: `#${hex[1].toLowerCase()}`, opacity: 100 }
  const match = value.match(/^rgba?\(([^)]+)\)$/)
  if (!match) throw new Error(`无法识别主题颜色：${value}`)
  const parts = match[1].match(/[\d.]+/g)?.map(Number)
  if (!parts || parts.length < 3)
    throw new UiError("styleWorkbenchModel.themeColorIsMissingRgbValues")
  return {
    hex: `#${parts
      .slice(0, 3)
      .map((part) => Math.round(part).toString(16).padStart(2, "0"))
      .join("")}`,
    opacity: rounded((parts[3] ?? 1) * 100),
  }
}
export function styleColor(hex: string, opacity: number) {
  const rgb = hex
    .slice(1)
    .match(/../g)!
    .map((part) => parseInt(part, 16))
  return `rgba(${rgb.join(", ")}, ${rounded(opacity / 100)})`
}

/** Measure the unmodified local probe so styles/theme.css remains the baseline source. */
export function readStyleBaseline(element: HTMLElement): StyleValues {
  const css = getComputedStyle(element)
  const number = (value: string) => {
    const parsed = parseFloat(value)
    if (!Number.isFinite(parsed))
      throw new UiError(
        "styleWorkbenchModel.couldNotReadCompleteThemeDimensionsConfirmThat",
      )
    return parsed
  }
  const surface = parseStyleColor(css.backgroundColor)
  const text = parseStyleColor(css.color)
  const border = parseStyleColor(css.borderTopColor)
  const accent = parseStyleColor(css.getPropertyValue("--primary").trim())
  const colorMatch = css.boxShadow.match(/rgba?\([^)]+\)/)
  const shadowColor = colorMatch
    ? parseStyleColor(colorMatch[0])
    : { hex: "#000000", opacity: 0 }
  const offsets = css.boxShadow
    .replace(/rgba?\([^)]+\)/g, "")
    .match(/-?[\d.]+px/g)
    ?.map(parseFloat) ?? [0, 0, 0, 0]
  return {
    radius: number(css.borderTopLeftRadius),
    controlHeight: number(css.getPropertyValue("--control-height")),
    padding: number(css.paddingTop),
    gap: number(css.gap),
    borderWidth: number(css.borderTopWidth),
    fontSize: number(css.fontSize),
    lineHeight: number(css.lineHeight),
    fontWeight: number(css.fontWeight),
    surfaceColor: surface.hex,
    surfaceOpacity: surface.opacity,
    textColor: text.hex,
    textOpacity: text.opacity,
    borderColor: border.hex,
    borderOpacity: border.opacity,
    accentColor: accent.hex,
    shadowEnabled: css.boxShadow !== "none",
    shadowInset: css.boxShadow.includes("inset"),
    shadowColor: shadowColor.hex,
    shadowOpacity: shadowColor.opacity,
    shadowX: offsets[0],
    shadowY: offsets[1],
    shadowBlur: offsets[2] ?? 0,
    shadowSpread: offsets[3] ?? 0,
    backdropBlur: number(css.backdropFilter.match(/[\d.]+/)?.[0] ?? "0"),
  }
}
export function styleDeclarations(values: StyleValues): Record<string, string> {
  return {
    "--control-radius": `${values.radius}px`,
    "--control-height": `${values.controlHeight}px`,
    "--surface": styleColor(values.surfaceColor, values.surfaceOpacity),
    "--foreground": styleColor(values.textColor, values.textOpacity),
    "--primary": values.accentColor,
    "--ring": values.accentColor,
    "--border": styleColor(values.borderColor, values.borderOpacity),
    "--lab-padding": `${values.padding}px`,
    "--lab-gap": `${values.gap}px`,
    "--lab-border-width": `${values.borderWidth}px`,
    "--lab-font-size": `${values.fontSize}px`,
    "--lab-line-height": `${values.lineHeight}px`,
    "--lab-font-weight": `${values.fontWeight}`,
    "--lab-backdrop-blur": `${values.backdropBlur}px`,
    "--lab-shadow": values.shadowEnabled
      ? `${values.shadowInset ? "inset " : ""}${values.shadowX}px ${values.shadowY}px ${values.shadowBlur}px ${values.shadowSpread}px ${styleColor(values.shadowColor, values.shadowOpacity)}`
      : "none",
  }
}
export function styleCSS(values: StyleValues) {
  const declarations = Object.entries(styleDeclarations(values))
    .map(([key, value]) => `  ${key}: ${value};`)
    .join("\n")
  return `/* 局部样式实验：应用到需要比较的容器 */\n.style-variant {\n${declarations}\n  display: grid;\n  padding: var(--lab-padding);\n  gap: var(--lab-gap);\n  border: var(--lab-border-width) solid var(--border);\n  border-radius: var(--control-radius);\n  background: var(--surface);\n  color: var(--foreground);\n  font-size: var(--lab-font-size);\n  line-height: var(--lab-line-height);\n  font-weight: var(--lab-font-weight);\n  box-shadow: var(--lab-shadow);\n  backdrop-filter: blur(var(--lab-backdrop-blur));\n}\n.style-variant :where(button, input) {\n  font-size: var(--lab-font-size);\n  line-height: var(--lab-line-height);\n  font-weight: var(--lab-font-weight);\n  border-width: var(--lab-border-width);\n}`
}
export function styleFieldLabel(key: StyleKey) {
  return (
    numericStyleControls.find((control) => control.key === key)?.label ??
    colorStyleControls.find((control) => control.key === key)?.label ??
    (key === "shadowEnabled" ? "启用阴影" : "内阴影")
  )
}
export function styleFieldValue(
  key: StyleKey,
  value: number | string | boolean,
) {
  if (typeof value === "boolean") return value ? "开启" : "关闭"
  const control = numericStyleControls.find((item) => item.key === key)
  return `${value}${control?.unit ?? ""}`
}
export function styleDifferences(baseline: StyleValues, current: StyleValues) {
  return (Object.keys(baseline) as StyleKey[])
    .filter((key) => baseline[key] !== current[key])
    .map((key) => ({
      key,
      label: styleFieldLabel(key),
      baseline: styleFieldValue(key, baseline[key]),
      current: styleFieldValue(key, current[key]),
      delta:
        typeof baseline[key] === "number" && typeof current[key] === "number"
          ? `${Number(current[key]) - Number(baseline[key]) > 0 ? "+" : ""}${styleFieldValue(key, rounded(Number(current[key]) - Number(baseline[key])))}`
          : "已更改",
    }))
}
