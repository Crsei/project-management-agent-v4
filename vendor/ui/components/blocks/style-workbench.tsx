"use client"
import { useUiFeedback } from "../../lib/i18n-provider"
import {
  uiMessage,
  builtInMessage,
  UiError,
  resolveUiText,
  type UiText,
} from "../../lib/i18n-core"
import { useI18n } from "../../lib/i18n-provider"

import { useEffect, useId, useRef, useState, type CSSProperties } from "react"
import { Copy, RotateCcw, ArrowLeftRight } from "lucide-react"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Badge } from "../ui/badge"
import { Tag } from "../ui/tag"
import { Chip } from "../ui/chip"
import { DataRegion } from "../ui/data-region"
import { cn } from "../../lib/utils"
import {
  clampStyleNumber,
  colorStyleControls,
  numericStyleControls,
  readStyleBaseline,
  styleCSS,
  styleDeclarations,
  styleDifferences,
  stylePresets,
  styleSections,
  type NumericStyleControl,
  type StyleSection,
  type StyleValues,
} from "../../lib/style-workbench-model"
import styles from "./style-workbench.module.css"

export type StyleWorkbenchProps = {
  initialSection?: StyleSection
  className?: string
}

function NumberControl({
  control,
  value,
  baseline,
  onChange,
}: {
  control: NumericStyleControl
  value: number
  baseline: number
  onChange: (value: number) => void
}) {
  const { t, builtIn } = useI18n()

  const id = useId()
  const [draft, setDraft] = useState<string>()
  function commit() {
    const number = draft?.trim() ? Number(draft) : NaN
    if (Number.isFinite(number)) onChange(clampStyleNumber(number, control))
    setDraft(undefined)
  }
  return (
    <div className={styles.numberControl}>
      <div>
        <label htmlFor={`${id}-range`}>{builtIn(control.label)}</label>
        <span>
          A: {baseline}
          {control.unit}
        </span>
      </div>
      <div>
        <input
          id={`${id}-range`}
          type="range"
          min={control.min}
          max={control.max}
          step={control.step}
          value={value}
          onChange={(event) => {
            setDraft(undefined)
            onChange(Number(event.target.value))
          }}
        />
        <Input
          aria-label={t("common.valueValue", {
            value0: builtIn(control.label),
          })}
          type="number"
          min={control.min}
          max={control.max}
          step={control.step}
          value={draft ?? value}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              commit()
            }
            if (event.key === "Escape") setDraft(undefined)
          }}
        />
        <span>{control.unit}</span>
      </div>
    </div>
  )
}

function PreviewSample({
  label,
  values,
  value,
  selected,
  onValueChange,
  onSelectedChange,
}: {
  label: string
  values: StyleValues
  value: string
  selected: boolean
  onValueChange: (value: string) => void
  onSelectedChange: (selected: boolean) => void
}) {
  const { t } = useI18n()

  const id = useId()
  return (
    <section className={styles.previewPane} aria-label={label}>
      <header>
        <span>{label}</span>
        <span>
          {values.radius}
          {t("styleWorkbench.pxRadius")}
          {values.controlHeight}
          {t("styleWorkbench.pxControls")}
        </span>
      </header>
      <div className={styles.stage}>
        <span className={styles.backdropMark} aria-hidden="true">
          Aa
          <br />
          SURFACE
          <br />
          012345
        </span>
        <div
          className={styles.sample}
          data-style-sample={label.startsWith("A") ? "baseline" : "modified"}
          style={styleDeclarations(values) as CSSProperties}
        >
          <div className={styles.sampleHeading}>
            <span>{t("styleWorkbench.designSystemReview")}</span>
            <Tag>{t("styleWorkbench.sample")}</Tag>
          </div>
          <p>
            {t(
              "styleWorkbench.compareBordersDensityAndReadabilityUsingIdenticalContent",
            )}
          </p>
          <div className={styles.sampleRows}>
            <div>
              <span>{t("styleWorkbench.foundations")}</span>
              <span>{t("styleWorkbench.12Items")}</span>
            </div>
            <div>
              <span>{t("styleWorkbench.componentSpecification")}</span>
              <span>{t("styleWorkbench.organized")}</span>
            </div>
          </div>
          <div className={styles.sampleField}>
            <label htmlFor={id}>{t("styleWorkbench.sampleInput")}</label>
            <Input
              id={id}
              value={value}
              onChange={(event) => onValueChange(event.target.value)}
            />
          </div>
          <div className={styles.sampleActions}>
            <Button
              aria-pressed={selected}
              onClick={() => onSelectedChange(!selected)}
            >
              {t("styleWorkbench.sampleButton")}
            </Button>
            <Chip
              label={t("styleWorkbench.filterValue")}
              selected={selected}
              onSelectedChange={onSelectedChange}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

export function StyleWorkbench({
  initialSection = "geometry",
  className,
}: StyleWorkbenchProps) {
  const { t, builtIn, locale } = useI18n()

  const probe = useRef<HTMLDivElement>(null)
  const [themeBaseline, setThemeBaseline] = useState<StyleValues>()
  const [pinnedBaseline, setPinnedBaseline] = useState<StyleValues>()
  const [edits, setEdits] = useState<Partial<StyleValues>>({})
  const [section, setSection] = useState<StyleSection>(initialSection)
  const [retry, setRetry] = useState(0)
  const [readError, setReadError] = useState<UiText>()
  const [feedback, setFeedback] = useUiFeedback("")
  const [output, setOutput] = useState<"css" | "json">("css")
  const [sampleValue, setSampleValue] = useState("视觉参数实验")
  const [sampleSelected, setSampleSelected] = useState(false)
  const baseline = pinnedBaseline ?? themeBaseline
  const current = baseline ? { ...baseline, ...edits } : undefined
  const differences =
    baseline && current ? styleDifferences(baseline, current) : []
  const code =
    baseline && current
      ? output === "css"
        ? styleCSS(current)
        : JSON.stringify({ version: 1, baseline, modified: current }, null, 2)
      : ""

  useEffect(() => {
    let frame = 0
    const read = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        try {
          if (!probe.current) return
          const values = readStyleBaseline(probe.current)
          setThemeBaseline((previous) =>
            JSON.stringify(previous) === JSON.stringify(values)
              ? previous
              : values,
          )
          setReadError(undefined)
        } catch (error) {
          setReadError(
            error instanceof UiError
              ? error.messageI18n
              : error instanceof Error
                ? error.message
                : uiMessage("styleWorkbench.theCurrentThemeHasNotFullyLoaded"),
          )
        }
      })
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [retry])

  function update<Key extends keyof StyleValues>(
    key: Key,
    value: StyleValues[Key],
  ) {
    setEdits((previous) => {
      const next = { ...previous, [key]: value }
      if (baseline?.[key] === value) delete next[key]
      return next
    })
    setFeedback("")
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setFeedback(
        output === "css"
          ? uiMessage("styleWorkbench.bCssCopied")
          : uiMessage("styleWorkbench.aBParameterJsonCopied"),
      )
    } catch {
      setFeedback(
        uiMessage(
          "styleWorkbench.clipboardUnavailableSelectAndCopyTheCodeBelow",
        ),
      )
    }
  }
  return (
    <div className={cn(styles.workbench, className)}>
      <div
        ref={probe}
        className={`${styles.sample} ${styles.probe}`}
        aria-hidden="true"
      />
      <DataRegion
        state={readError ? "error" : baseline ? "success" : "loading"}
        hasContent={Boolean(baseline)}
        loadingLabel={t("styleWorkbench.readingThemeBaseline")}
        error={
          readError
            ? {
                category: "validation",
                message: t("styleWorkbench.couldNotReadStyleBaseline"),
                reason: resolveUiText(locale, readError),
              }
            : undefined
        }
        onRetry={() => setRetry((value) => value + 1)}
      >
        {baseline && current && (
          <>
            <div className={styles.toolbar}>
              <div>
                <Badge tone="info">A / B</Badge>
                <span>
                  {pinnedBaseline
                    ? t("styleWorkbench.aIsPinned")
                    : t("styleWorkbench.aFollowsTheCurrentTheme")}
                </span>
                <span>
                  {differences.length} {t("styleWorkbench.differences")}
                </span>
              </div>
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setPinnedBaseline({ ...current })
                    setEdits({})
                    setFeedback(uiMessage("styleWorkbench.bPinnedAsBaselineA"))
                  }}
                >
                  <ArrowLeftRight />
                  {t("styleWorkbench.setBAsBaselineA")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!differences.length}
                  onClick={() => {
                    setEdits({})
                    setFeedback(uiMessage("styleWorkbench.bResetToBaselineA"))
                  }}
                >
                  <RotateCcw />
                  {t("styleWorkbench.resetB")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setPinnedBaseline(undefined)
                    setEdits({})
                    setFeedback(
                      uiMessage(
                        "styleWorkbench.currentProjectThemeBaselineRestored",
                      ),
                    )
                  }}
                >
                  {t("styleWorkbench.restoreProjectDefaults")}
                </Button>
              </div>
            </div>
            <div className={styles.body}>
              <aside
                className={styles.controls}
                aria-label={t("styleWorkbench.styleParameters")}
              >
                <nav
                  className={styles.sectionNav}
                  aria-label={t("styleWorkbench.parameterCategories")}
                >
                  {styleSections.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      aria-pressed={section === item.id}
                      onClick={() => setSection(item.id)}
                    >
                      {builtIn(item.label)}
                    </button>
                  ))}
                </nav>
                <section
                  className={styles.fields}
                  aria-label={t("common.valueParameters", {
                    value0: builtIn(
                      styleSections.find((item) => item.id === section)
                        ?.label ?? "",
                    ),
                  })}
                >
                  {section === "shadow" && (
                    <div className={styles.checks}>
                      <label>
                        <input
                          type="checkbox"
                          checked={current.shadowEnabled}
                          onChange={(event) =>
                            update("shadowEnabled", event.target.checked)
                          }
                        />
                        {t("styleWorkbench.enableShadow")}
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={current.shadowInset}
                          disabled={!current.shadowEnabled}
                          onChange={(event) =>
                            update("shadowInset", event.target.checked)
                          }
                        />
                        {t("styleWorkbench.insetShadow")}
                      </label>
                    </div>
                  )}
                  {numericStyleControls
                    .filter((control) => control.section === section)
                    .map((control) => (
                      <NumberControl
                        key={control.key}
                        control={control}
                        value={current[control.key]}
                        baseline={baseline[control.key]}
                        onChange={(value) => update(control.key, value)}
                      />
                    ))}
                  {colorStyleControls
                    .filter((control) => control.section === section)
                    .map((control) => (
                      <label key={control.key} className={styles.colorControl}>
                        <span>{builtIn(control.label)}</span>
                        <Input
                          type="color"
                          aria-label={builtIn(control.label)}
                          value={current[control.key]}
                          onChange={(event) =>
                            update(control.key, event.target.value)
                          }
                        />
                        <code>{current[control.key]}</code>
                      </label>
                    ))}
                </section>
                <section
                  className={styles.presets}
                  aria-label={t("styleWorkbench.stylePresets")}
                >
                  <h3>{t("styleWorkbench.tryAPreset")}</h3>
                  <div>
                    {stylePresets.map((preset) => (
                      <Button
                        key={preset.id}
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setEdits(preset.values)
                          setSection(preset.section)
                          setFeedback(
                            uiMessage("common.appliedValueToB", {
                              value0: builtInMessage(preset.name),
                            }),
                          )
                        }}
                      >
                        {builtIn(preset.name)}
                      </Button>
                    ))}
                  </div>
                  <p>
                    {t(
                      "styleWorkbench.presetsAreLocalExperimentsTouchControlsRetainTargets",
                    )}
                  </p>
                </section>
              </aside>
              <div className={styles.results}>
                <div className={styles.comparison}>
                  <PreviewSample
                    label={t("styleWorkbench.aBaseline")}
                    values={baseline}
                    value={sampleValue}
                    selected={sampleSelected}
                    onValueChange={setSampleValue}
                    onSelectedChange={setSampleSelected}
                  />
                  <PreviewSample
                    label={t("styleWorkbench.bCurrentChanges")}
                    values={current}
                    value={sampleValue}
                    selected={sampleSelected}
                    onValueChange={setSampleValue}
                    onSelectedChange={setSampleSelected}
                  />
                </div>
                <section
                  className={styles.differences}
                  aria-label={t("styleWorkbench.parameterDifferences")}
                >
                  <h3>
                    {t("styleWorkbench.parameterDifferences")}
                    <span>
                      {differences.length} {t("canvasWorkspace.issues")}
                    </span>
                  </h3>
                  {differences.length ? (
                    <div className={styles.tableScroll}>
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">{t("styleWorkbench.parameter")}</th>
                            <th scope="col">{t("styleWorkbench.aBaseline")}</th>
                            <th scope="col">{t("styleWorkbench.bCurrent")}</th>
                            <th scope="col">
                              {t("styleWorkbench.difference")}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {differences.map((item) => (
                            <tr key={item.key}>
                              <th scope="row">{builtIn(item.label)}</th>
                              <td>{item.baseline}</td>
                              <td>{item.current}</td>
                              <td>{item.delta}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p>
                      {t("styleWorkbench.aAndBAreIdenticalAdjustParametersOn")}
                    </p>
                  )}
                </section>
                <section
                  className={styles.export}
                  aria-label={t("styleWorkbench.exportStyles")}
                >
                  <div>
                    <div>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-pressed={output === "css"}
                        onClick={() => {
                          setOutput("css")
                          setFeedback("")
                        }}
                      >
                        CSS
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-pressed={output === "json"}
                        onClick={() => {
                          setOutput("json")
                          setFeedback("")
                        }}
                      >
                        {t("styleWorkbench.parameterJson")}
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={
                        output === "css"
                          ? t("styleWorkbench.copyCss")
                          : t("styleWorkbench.copyParameterJson")
                      }
                      onClick={copy}
                    >
                      <Copy />
                    </Button>
                  </div>
                  <pre
                    tabIndex={0}
                    aria-label={
                      output === "css"
                        ? t("styleWorkbench.currentCss")
                        : t("styleWorkbench.currentParameterJson")
                    }
                  >
                    <code>{code}</code>
                  </pre>
                </section>
              </div>
            </div>
          </>
        )}
      </DataRegion>
      <p role="status" className={styles.feedback}>
        {feedback}
      </p>
    </div>
  )
}
