"use client"
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { Button } from "../../ui/button"
import {
  ChartAxis,
  ChartFrame,
  ChartLegend,
  ChartTooltip,
  type ChartFrameProps,
} from "../../ui/chart"
import { ChartDataTable } from "./chart-data-table"
import {
  chartData,
  chartDrilldown,
  chartSeriesColor,
  type ChartDatum,
  type ChartKind,
  type ChartReferenceDefinition,
  type ChartSelection,
} from "../../../lib/chart-model"
import type { AnalyticsResult, DrilldownSelection } from "../../../lib/analytics-model"
import { useI18n } from "../../../lib/i18n-provider"
import { analyticsQueryKey } from "../../../lib/analytics-query"
import styles from "./statistical-chart.module.css"

export type StatisticalChartProps = Omit<
  ChartFrameProps,
  "children" | "result"
> & {
  result: AnalyticsResult | null
  widgetId: string
  kind: ChartKind
  height?: number
  stacked?: boolean
  composition?: "exclusive"
  xType?: "category" | "time" | "number"
  xUnit?: string
  /** Display formatting only; tooltips, tables and selections retain full values. */
  yTickFormatter?: (value: number) => string
  domain?: [number, number]
  references?: readonly ChartReferenceDefinition[]
  selection?: ChartSelection
  onSelectionChange?: (selection: ChartSelection) => void
  onDrilldown?: (selection: DrilldownSelection) => void
  onExportImage?: (svg: SVGSVGElement) => void
}
export function ChartReference({
  reference,
}: {
  reference: ChartReferenceDefinition
}) {
  if (
    !Number.isFinite(reference.value) ||
    (reference.upper !== undefined && !Number.isFinite(reference.upper))
  )
    return null
  return reference.upper === undefined ? (
    <ReferenceLine
      y={reference.value}
      stroke="var(--chart-reference)"
      strokeDasharray="4 4"
      label={{
        value: reference.label,
        fill: "var(--text-secondary)",
        fontSize: 12,
      }}
    />
  ) : (
    <ReferenceArea
      y1={reference.value}
      y2={reference.upper}
      fill="var(--chart-reference)"
      fillOpacity={0.08}
      label={{
        value: reference.label,
        fill: "var(--text-secondary)",
        fontSize: 12,
      }}
    />
  )
}
export function StatisticalChart(props: StatisticalChartProps) {
  const { t, locale } = useI18n()
  const plotRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<"chart" | "table">("chart")
  const [hiddenIds, setHiddenIds] = useState<string[]>([])
  const [cursor, setCursor] = useState(0)
  const [keyboardFocused, setKeyboardFocused] = useState(false)
  const cursorId = useId()
  const embedded = props.presentation === "embedded"
  const result =
    props.access !== "denied" &&
    props.result?.queryKey === analyticsQueryKey(props.query)
      ? props.result
      : null
  const data = result ? chartData(result) : []
  const visible = data.filter((datum) => !hiddenIds.includes(datum.series.id))
  const current = visible[Math.min(cursor, Math.max(visible.length - 1, 0))]
  const canOpenCurrentSource = !!props.onDrilldown && !!current?.point.drilldown
  const keyboardInstruction = t(canOpenCurrentSource ? "analytics.keyboard" : "analytics.keyboardInspect")
  function select(datum: ChartDatum) {
    props.onSelectionChange?.({
      seriesId: datum.series.id,
      bucketId: datum.point.bucketId,
    })
    const drilldown = chartDrilldown(datum, props.widgetId)
    if (drilldown) props.onDrilldown?.(drilldown)
  }
  function keyDown(event: KeyboardEvent) {
    if (!visible.length) return
    if (
      [
        "ArrowRight",
        "ArrowDown",
        "ArrowLeft",
        "ArrowUp",
        "Home",
        "End",
        "Enter",
      ].includes(event.key)
    )
      event.preventDefault()
    if (event.key === "Enter" && current && (canOpenCurrentSource || props.onSelectionChange)) select(current)
    else if (event.key === "Home") setCursor(0)
    else if (event.key === "End") setCursor(visible.length - 1)
    else if (["ArrowRight", "ArrowDown"].includes(event.key))
      setCursor((Math.min(cursor, visible.length - 1) + 1) % visible.length)
    else if (["ArrowLeft", "ArrowUp"].includes(event.key))
      setCursor(
        (Math.min(cursor, visible.length - 1) + visible.length - 1) %
          visible.length,
      )
  }
  const invalidDonut =
    props.kind === "donut" &&
    (props.composition !== "exclusive" ||
      result?.series.length !== 1 ||
      data.some((d) => d.point.value !== null && d.point.value < 0))
  const series = result?.series.filter((s) => !hiddenIds.includes(s.id)) ?? []
  const timeAxis = props.xType === "time" || props.xType === "number"
  const rows: Record<string, string | number | null>[] = []
  const rowIndex = new Map<string, number>()
  for (const datum of data) {
    if (timeAxis && !Number.isFinite(datum.point.x)) continue
    if (!rowIndex.has(datum.point.bucketId)) {
      rowIndex.set(datum.point.bucketId, rows.length)
      rows.push({
        bucketId: datum.point.bucketId,
        label: datum.point.label,
        x: timeAxis ? (datum.point.x ?? null) : datum.point.bucketId,
      })
    }
    const index = result!.series.findIndex((s) => s.id === datum.series.id)
    rows[rowIndex.get(datum.point.bucketId)!][`v${index}`] = datum.point.value
  }
  if (timeAxis) rows.sort((a, b) => Number(a.x) - Number(b.x))
  const datumIndex = new Map(data.map((datum) => [datum.key, datum]))
  const lookup = (seriesId: string, bucketId: string) =>
    datumIndex.get(JSON.stringify([seriesId, bucketId]))
  const color = (datum: ChartDatum) => {
    if (
      props.kind === "donut" &&
      !["backlog", "active", "completed", "cancelled"].includes(
        datum.point.bucketId,
      )
    ) {
      let hash = 0
      for (const char of datum.point.bucketId)
        hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0
      const slots = ["1", "2", "3", "4", "5"] as const
      return chartSeriesColor(slots[hash % slots.length])
    }
    return chartSeriesColor(datum.series.color, datum.point.bucketId)
  }
  const pointDot = (seriesId: string) =>
    function ChartPointDot(raw: unknown) {
      const dot = raw as {
        cx?: number
        cy?: number
        payload?: { bucketId?: string }
      }
      const datum = lookup(seriesId, dot.payload?.bucketId ?? "")
      if (
        !datum ||
        datum.point.value === null ||
        !Number.isFinite(dot.cx) ||
        !Number.isFinite(dot.cy)
      )
        return <g />
      const selected =
        props.selection?.seriesId === seriesId &&
        props.selection.bucketId === datum.point.bucketId
      return (
        <circle
          cx={dot.cx}
          cy={dot.cy}
          r={selected ? 6 : 4}
          fill={color(datum)}
          stroke={selected ? "var(--chart-selected)" : "var(--surface)"}
          strokeWidth={2}
          data-chart-point={datum.key}
          onClick={() => select(datum)}
          style={{ cursor: datum.point.drilldown ? "pointer" : "default" }}
        />
      )
    }
  const chartTooltip = (raw: unknown) => {
    const payload = raw as {
      active?: boolean
      payload?: { payload?: { bucketId?: string } }[]
    }
    const id = payload.payload?.[0]?.payload?.bucketId
    if (!payload.active || !id) return null
    return (
      <div className={styles.tip}>
        {visible
          .filter((d) => d.point.bucketId === id)
          .map((d) => (
            <ChartTooltip key={d.key} datum={d} unit={result!.unit} />
          ))}
      </div>
    )
  }
  let plot: ReactNode = null
  if (result && !invalidDonut) {
    if (props.kind === "donut") {
      const pieData = visible
        .filter((d) => d.point.value !== null)
        .map((d) => ({
          bucketId: d.point.bucketId,
          label: d.point.label,
          value: d.point.value,
          datum: d,
        }))
      plot = (
        <PieChart accessibilityLayer={false}>
          <Pie
            data={pieData}
            dataKey="value"
            nameKey="label"
            innerRadius="55%"
            outerRadius="80%"
            isAnimationActive={false}
            onClick={(_, index) => {
              if (pieData[index]) select(pieData[index].datum)
            }}
          >
            {pieData.map((d) => (
              <Cell
                key={d.datum.key}
                fill={color(d.datum)}
                stroke={
                  props.selection?.bucketId === d.bucketId
                    ? "var(--chart-selected)"
                    : "var(--surface)"
                }
                strokeWidth={2}
              />
            ))}
          </Pie>
          <Tooltip content={chartTooltip} active={embedded && keyboardFocused ? false : undefined} />
        </PieChart>
      )
    } else {
      plot = (
        <ComposedChart
          data={rows}
          accessibilityLayer={false}
          margin={{ top: 12, right: 16, bottom: 8, left: 0 }}
        >
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis
            dataKey="x"
            type={timeAxis ? "number" : "category"}
            domain={timeAxis ? ["dataMin", "dataMax"] : undefined}
            scale={props.xType === "time" ? "time" : "auto"}
            tick={{ fill: "var(--text-secondary)", fontSize: 12 }}
            tickFormatter={(value) =>
              props.xType === "time"
                ? new Intl.DateTimeFormat(locale, {
                    timeZone: props.query.timeZone,
                    month: "short",
                    day: "numeric",
                  }).format(Number(value))
                : (rows
                    .find((row) => row.bucketId === value)
                    ?.label?.toString() ?? String(value))
            }
            minTickGap={24}
          />
          <YAxis
            domain={props.domain ?? [0, "auto"]}
            tick={{ fill: "var(--text-secondary)", fontSize: 12 }}
            tickFormatter={props.yTickFormatter}
            width={44}
          />
          <Tooltip content={chartTooltip} active={embedded && keyboardFocused ? false : undefined} />
          {props.references?.map((reference) => (
            <ChartReference key={reference.id} reference={reference} />
          ))}
          {series.map((s) => {
            const index = result.series.findIndex((item) => item.id === s.id)
            const common = {
              dataKey: `v${index}`,
              name: s.label,
              stroke: chartSeriesColor(s.color),
              fill: chartSeriesColor(s.color),
              isAnimationActive: false,
            }
            if (props.kind === "bar")
              return (
                <Bar
                  key={s.id}
                  {...common}
                  stackId={props.stacked ? "stack" : undefined}
                  maxBarSize={48}
                  onClick={(_, i) => {
                    const datum = lookup(s.id, String(rows[i]?.bucketId))
                    if (datum) select(datum)
                  }}
                >
                  {rows.map((row) => {
                    const datum = lookup(s.id, String(row.bucketId))
                    return (
                      <Cell
                        key={String(row.bucketId)}
                        fill={datum ? color(datum) : common.fill}
                        stroke={
                          props.selection?.seriesId === s.id &&
                          props.selection.bucketId === row.bucketId
                            ? "var(--chart-selected)"
                            : "none"
                        }
                        strokeWidth={2}
                      />
                    )
                  })}
                </Bar>
              )
            if (props.kind === "scatter")
              return <Scatter key={s.id} {...common} shape={pointDot(s.id)} />
            if (props.kind === "area")
              return (
                <Area
                  key={s.id}
                  {...common}
                  type="linear"
                  connectNulls={false}
                  fillOpacity={0.15}
                  stackId={props.stacked ? "stack" : undefined}
                  dot={pointDot(s.id)}
                  activeDot={pointDot(s.id)}
                />
              )
            return (
              <Line
                key={s.id}
                {...common}
                type="linear"
                connectNulls={false}
                strokeWidth={2}
                dot={pointDot(s.id)}
                activeDot={pointDot(s.id)}
              />
            )
          })}
        </ComposedChart>
      )
    }
  }
  const showPlot = mode === "chart" && !invalidDonut && series.length > 0
  const legend = result && (
    <ChartLegend
      series={result.series}
      hiddenIds={hiddenIds}
      onHiddenIdsChange={setHiddenIds}
    />
  )
  const axis = result && (embedded || showPlot) && (
    <ChartAxis unit={result.unit} domain={props.domain} xUnit={props.xUnit} />
  )
  const pointControls = result && showPlot && (
    <>
      <div
        className={styles.cursor}
        tabIndex={0}
        role="group"
        aria-label={keyboardInstruction}
        onKeyDown={keyDown}
      >
        <span className={styles.meta}>{keyboardInstruction}</span>
        <div aria-live="polite">
          <ChartTooltip datum={current} unit={result.unit} />
        </div>
      </div>
      {current?.point.drilldown && props.onDrilldown && (
        <Button size="sm" variant="secondary" onClick={() => select(current)}>
          {t("analytics.open")}: {current.point.label}
        </Button>
      )}
      {visible.length > 0 && visible.every((d) => d.point.value === 0) && (
        <p className={styles.meta}>{t("analytics.zero")}</p>
      )}
    </>
  )
  const table = result && mode === "table" && (
    <ChartDataTable
      result={result}
      selection={props.selection}
      onSelect={props.onDrilldown || props.onSelectionChange ? select : undefined}
    />
  )
  return (
    <ChartFrame
      {...props}
      details={embedded ? <>{legend}{axis}{pointControls}{props.details}</> : props.details}
      actions={
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={mode === "chart"}
            onClick={() => setMode("chart")}
          >
            {t("analytics.chart")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={mode === "table"}
            onClick={() => setMode("table")}
          >
            {t("analytics.table")}
          </Button>
          {props.onExportImage && (
            <Button
              size="sm"
              variant="ghost"
              disabled={
                mode !== "chart" || !result || invalidDonut || !series.length
              }
              onClick={() => {
                const svg = plotRef.current?.querySelector<SVGSVGElement>(
                  "svg.recharts-surface",
                )
                if (svg) props.onExportImage?.(svg)
              }}
            >
              {t("analytics.exportImage")}
            </Button>
          )}
          {props.actions}
        </div>
      }
    >
      {result && (
        <>
          {!embedded && legend}
          {mode === "table" ? (
            embedded ? (
              <div className={styles.table} style={{ height: props.height ?? 240 }}>{table}</div>
            ) : table
          ) : invalidDonut ? (
            <p>{t("analytics.donutInvalid")}</p>
          ) : !series.length ? (
            <p>{t("analytics.hidden")}</p>
          ) : (
            <>
              {!embedded && axis}
              <div
                ref={plotRef}
                className={embedded ? `${styles.plot} ${styles.embeddedPlot}` : styles.plot}
                style={{ height: props.height ?? 240 }}
                tabIndex={embedded ? 0 : undefined}
                role={embedded ? "group" : undefined}
                aria-label={embedded ? keyboardInstruction : undefined}
                aria-describedby={embedded ? cursorId : undefined}
                onKeyDown={embedded ? keyDown : undefined}
                onFocus={embedded ? () => setKeyboardFocused(true) : undefined}
                onBlur={embedded ? () => setKeyboardFocused(false) : undefined}
              >
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  {plot as React.ReactElement}
                </ResponsiveContainer>
                {embedded && (
                  <div
                    id={cursorId}
                    className={keyboardFocused ? styles.embeddedReadout : "sr-only"}
                    aria-live={keyboardFocused ? "polite" : "off"}
                  >
                    <ChartTooltip datum={current} unit={result.unit} />
                  </div>
                )}
              </div>
              {!embedded && pointControls}
            </>
          )}
        </>
      )}
    </ChartFrame>
  )
}
export const BarChart = (props: Omit<StatisticalChartProps, "kind">) => (
  <StatisticalChart {...props} kind="bar" />
)
export const LineChart = (props: Omit<StatisticalChartProps, "kind">) => (
  <StatisticalChart {...props} kind="line" />
)
export const AreaChart = (props: Omit<StatisticalChartProps, "kind">) => (
  <StatisticalChart {...props} kind="area" />
)
export const DonutChart = (props: Omit<StatisticalChartProps, "kind">) => (
  <StatisticalChart {...props} kind="donut" />
)
export const ScatterChart = (props: Omit<StatisticalChartProps, "kind">) => (
  <StatisticalChart {...props} kind="scatter" />
)
