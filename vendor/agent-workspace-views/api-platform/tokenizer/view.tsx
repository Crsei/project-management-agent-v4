"use client"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  Copy,
  Download,
  Hash,
  LetterText,
  LoaderCircle,
  Type,
  Search,
  X,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Card } from "@easyuse-ui/ui/components/ui/card"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Switch } from "@easyuse-ui/ui/components/ui/switch"
import { Progress } from "@easyuse-ui/ui/components/ui/progress"
import {
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel,
} from "@easyuse-ui/ui/components/ui/tabs"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { ApPage, ApSelect } from "../shared"
import { useApState } from "../state"
import { apScenarios, type ApScenario } from "../model"
import type { RemainingPageProps } from "../../showcase/model"
import {
  createTokenizerState,
  tokenizerExamples,
  tokenizerLimits,
  tokenizerVersion,
} from "./fixtures"
import type {
  TokenizerMode,
  TokenizerOutput,
  TokenizerEncoding,
} from "./fixtures"
import {
  analysisJson,
  tokenIdsJson,
  showWhitespace,
  validBudget,
} from "./controller"
import type {
  TokenAnalysis,
  TokenFailure,
  TokenRequest,
  TokenResponse,
} from "./controller"
import styles from "./tokenizer.module.css"

type Job = {
  key: string
  busy: boolean
  result: TokenAnalysis | null
  error: TokenFailure | null
  cancelled: boolean
}
export const pageScenarios = apScenarios

export function RemainingPageView({ scenario, active }: RemainingPageProps) {
  return <TokenizerView scenario={scenario as ApScenario} active={active} />
}

export function TokenizerView({
  scenario,
  active = true,
}: {
  scenario: ApScenario
  active?: boolean
}) {
  const { locale } = useI18n()
  const en = locale === "en",
    copy = (english: string, chinese: string) => (en ? english : chinese)
  const [state, setState] = useApState("tokenizer:" + scenario, () =>
    createTokenizerState(scenario),
  )
  const [job, setJob] = useState<Job>({
    key: "",
    busy: true,
    result: null,
    error: null,
    cancelled: false,
  })
  const [retry, setRetry] = useState(0)
  const [notice, setNotice] = useState("")
  const [copying, setCopying] = useState(false)
  const copyInFlight = useRef(false)
  const [visibleCount, setVisibleCount] = useState(500)
  const worker = useRef<Worker | null>(null),
    operation = useRef(0),
    editor = useRef<HTMLTextAreaElement>(null)
  const workerBusy = useRef(false),
    selectionMemory = useRef(state.selection)
  const input = state.mode === "encode" ? state.text : state.ids
  const requestKey = useMemo(
    () => state.encoding + ":" + state.mode + ":" + input,
    [state.encoding, state.mode, input],
  )
  const readonly = scenario === "readonly"
  const loadFault =
    state.fault === "loading" || state.fault === "missing-data"
      ? state.fault
      : "none"
  useEffect(
    () => () => {
      ++operation.current
      worker.current?.terminate()
      worker.current = null
    },
    [active],
  )
  useEffect(() => {
    if (!active) return
    const operationId = ++operation.current
    const timeout = setTimeout(() => {
      if (operationId !== operation.current) return
      if (loadFault === "loading") {
        setJob({
          key: requestKey,
          busy: true,
          result: null,
          error: null,
          cancelled: false,
        })
        return
      }
      if (loadFault === "missing-data") {
        setJob({
          key: requestKey,
          busy: false,
          result: null,
          error: { code: "engine" },
          cancelled: false,
        })
        return
      }
      setJob({
        key: requestKey,
        busy: true,
        result: null,
        error: null,
        cancelled: false,
      })
      let active: Worker
      try {
        active =
          worker.current ??
          new Worker(new URL("./tokenizer.worker.ts", import.meta.url), {
            type: "module",
          })
        worker.current = active
      } catch {
        setJob({
          key: requestKey,
          busy: false,
          result: null,
          error: { code: "engine" },
          cancelled: false,
        })
        return
      }
      active.onmessage = ({ data }: MessageEvent<TokenResponse>) => {
        if (data.operationId !== operation.current) return
        workerBusy.current = false
        setJob(
          "result" in data
            ? {
                key: requestKey,
                busy: false,
                result: data.result,
                error: null,
                cancelled: false,
              }
            : {
                key: requestKey,
                busy: false,
                result: null,
                error: data.error,
                cancelled: false,
              },
        )
      }
      active.onerror = () => {
        if (worker.current !== active || operationId !== operation.current)
          return
        setJob({
          key: requestKey,
          busy: false,
          result: null,
          error: { code: "engine" },
          cancelled: false,
        })
        workerBusy.current = false
        active.terminate()
        if (worker.current === active) worker.current = null
      }
      workerBusy.current = true
      active.postMessage({
        operationId,
        encoding: state.encoding,
        mode: state.mode,
        input,
      } satisfies TokenRequest)
    }, 120)
    return () => {
      clearTimeout(timeout)
      if (workerBusy.current) {
        worker.current?.terminate()
        worker.current = null
        workerBusy.current = false
      }
    }
  }, [active, state.encoding, state.mode, input, loadFault, retry, requestKey])
  useLayoutEffect(() => {
    selectionMemory.current = state.selection
  }, [state.selection])
  useLayoutEffect(() => {
    const saved = selectionMemory.current[state.mode]
    editor.current?.setSelectionRange(saved.start, saved.end)
    if (editor.current) editor.current.scrollTop = saved.scrollTop
  }, [state.mode])
  const current = job.key === requestKey
  const result = current ? job.result : null
  const busy = !current || job.busy
  const piece =
    result?.pieces[Math.min(state.selected, (result?.pieces.length ?? 1) - 1)]
  const idsJson = useMemo(() => (result ? tokenIdsJson(result) : ""), [result])
  const json = useMemo(() => (result ? analysisJson(result) : ""), [result])
  const budgetValid = validBudget(state.budget),
    budget = budgetValid ? Number(state.budget) : 0
  const number = (value: number) => new Intl.NumberFormat(locale).format(value)
  const hex =
    piece?.bytes
      .map((value) => value.toString(16).padStart(2, "0"))
      .join(" ") ?? ""
  const errorText =
    current && job.error
      ? {
          "text-limit": copy(
            "Text is limited to 20,000 UTF-16 characters. Shorten the text and try again.",
            "文本最多20,000个UTF-16字符。请缩短后重试。",
          ),
          "ids-limit": copy(
            "Use up to 10,000 token IDs and 80,000 input characters.",
            "最多输入10,000个Token ID及80,000个字符。",
          ),
          "ids-format": copy(
            "Enter a JSON array or comma-separated non-negative integer token IDs. Strings, decimals and empty entries are not valid IDs.",
            "请输入JSON数组或逗号分隔的非负整数Token ID。字符串、小数和空项不是合法ID。",
          ),
          "invalid-id": copy(
            "Token ID " +
              job.error.id +
              " at position " +
              job.error.position +
              " does not exist in " +
              state.encoding +
              ". Correct this ID.",
            "第" +
              job.error.position +
              "项Token ID " +
              job.error.id +
              "不在" +
              state.encoding +
              "词表中，请修改。",
          ),
          engine: copy(
            "The local encoding could not be loaded. Your draft is preserved; retry loading it.",
            "本地编码器加载失败。草稿已保留，请重试加载。",
          ),
        }[job.error.code]
      : undefined
  function changeMode(mode: TokenizerMode) {
    setState((before) => ({
      ...before,
      mode,
      ids:
        mode === "decode" && !before.idsInitialized && !before.ids && result
          ? idsJson
          : before.ids,
      idsInitialized: mode === "decode" ? true : before.idsInitialized,
    }))
  }
  function rememberEditor() {
    if (!editor.current) return
    const {
      selectionStart: start,
      selectionEnd: end,
      scrollTop,
    } = editor.current
    setState((before) => {
      const saved = before.selection[before.mode]
      if (
        saved.start === start &&
        saved.end === end &&
        saved.scrollTop === scrollTop
      )
        return before
      return {
        ...before,
        selection: {
          ...before.selection,
          [before.mode]: { start, end, scrollTop },
        },
      }
    })
  }
  async function copyResult(format: "ids" | "json") {
    if (!result || copyInFlight.current) return
    copyInFlight.current = true
    setCopying(true)
    try {
      await navigator.clipboard.writeText(format === "ids" ? idsJson : json)
      setNotice(
        copy(
          format === "ids" ? "Token IDs copied." : "Analysis JSON copied.",
          format === "ids" ? "已复制Token ID。" : "已复制分析JSON。",
        ),
      )
    } catch {
      setNotice(
        copy(
          "Clipboard access failed. Select the output to copy it manually.",
          "无法访问剪贴板，请选中输出内容手动复制。",
        ),
      )
    } finally {
      copyInFlight.current = false
      setCopying(false)
    }
  }
  function exportResult() {
    if (!result) return
    const url = URL.createObjectURL(
      new Blob([json + "\n"], { type: "application/json;charset=utf-8" }),
    )
    const link = document.createElement("a")
    link.href = url
    link.download = "tokenizer-" + state.encoding + ".json"
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    setNotice(copy("Analysis exported.", "已导出分析。"))
  }
  function cancel() {
    ++operation.current
    worker.current?.terminate()
    worker.current = null
    workerBusy.current = false
    setJob({
      key: requestKey,
      busy: false,
      result: null,
      error: null,
      cancelled: true,
    })
  }
  const title = copy("Tokenizer", "分词器")
  return (
    <div className={styles.page}>
      <ApPage
        pageId="tokenizer"
        variant="reference"
        title={title}
        description={copy(
          "See how text becomes tokens. Compare encodings, inspect token IDs, and plan how much context your prompt needs.",
          "查看文本如何变成Token。比较编码，检查Token ID，并规划提示词需要的上下文。",
        )}
        actions={
          <Button
            variant="outline"
            size="lg"
            onClick={exportResult}
            disabled={!result}
          >
            <Download aria-hidden="true" size={16} />
            {copy("Export analysis", "导出分析")}
          </Button>
        }
        toolbar={
          <div className={styles.toolbar}>
            <div className={styles.encoding}>
              <ApSelect
                label={copy("Encoding", "编码")}
                value={state.encoding}
                onChange={(value) =>
                  setState((before) => ({
                    ...before,
                    encoding: value as TokenizerEncoding,
                  }))
                }
                options={[
                  { value: "o200k_base", label: "o200k_base" },
                  { value: "cl100k_base", label: "cl100k_base" },
                ]}
              />
              <span className={styles.local}>
                <span aria-hidden="true" />
                {copy("Local BPE tokenizer", "本地BPE分词器")}
              </span>
            </div>
            <span className={styles.muted}>
              {copy("Plain text only · no API calls", "仅纯文本 · 不调用API")}
            </span>
          </div>
        }
      >
        <div
          className={styles.root}
          data-tokenizer-hydrated={job.key !== ""}
          data-tokenizer-status={
            busy
              ? "pending"
              : job.error
                ? "error"
                : job.cancelled
                  ? "cancelled"
                  : "ready"
          }
          data-tokenizer-version={tokenizerVersion}
        >
          {readonly && (
            <p className={styles.banner}>
              {copy(
                "Read-only scenario. Inspect, copy and export are available; editing is disabled.",
                "只读场景：可以检查、复制和导出，不能编辑。",
              )}
            </p>
          )}
          {state.fault === "refresh-error" && result && (
            <div role="alert" className={styles.banner}>
              {copy(
                "Refresh failed. The last local analysis and your draft are preserved.",
                "刷新失败，保留上次本地分析和草稿。",
              )}{" "}
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setState((before) => ({ ...before, fault: "none" }))
                }
              >
                {copy("Retry", "重试")}
              </Button>
            </div>
          )}
          <div className={styles.metrics}>
            {[
              {
                label: copy("Tokens", "Token数"),
                value: result ? number(result.tokenCount) : busy ? "…" : "—",
                note: copy(
                  "Exact count for " + state.encoding,
                  state.encoding + "精确计数",
                ),
                icon: Hash,
                id: "tokens",
              },
              {
                label: copy("Characters", "字符数"),
                value: result
                  ? number(result.characterCount)
                  : busy
                    ? "…"
                    : "—",
                note: copy(
                  "Unicode code points, including spaces",
                  "Unicode码点，含空格",
                ),
                icon: LetterText,
                id: "characters",
              },
              {
                label: copy("Chars / token", "字符 / Token"),
                value:
                  result?.charsPerToken != null
                    ? result.charsPerToken.toFixed(2)
                    : busy
                      ? "…"
                      : "—",
                note: copy(
                  "Varies with language and content",
                  "随语言和内容变化",
                ),
                icon: Type,
                id: "ratio",
              },
            ].map((metric) => (
              <Card key={metric.id} className={styles.metric}>
                <div className={styles.metricLabel}>
                  {metric.label}
                  <metric.icon aria-hidden="true" size={16} />
                </div>
                <p
                  className={styles.metricValue}
                  data-tokenizer-metric={metric.id}
                >
                  {metric.value}
                </p>
                <p className={styles.muted}>{metric.note}</p>
              </Card>
            ))}
          </div>
          <div className={styles.analysis}>
            <div className={styles.compare}>
              <Card
                className={styles.card}
                aria-labelledby="tokenizer-input-heading"
              >
                <Tabs
                  value={state.mode}
                  onValueChange={(value) => changeMode(value as TokenizerMode)}
                >
                  <div className={styles.cardHeading}>
                    <div>
                      <h2 id="tokenizer-input-heading">
                        {copy("Input", "输入")}
                      </h2>
                      <p>
                        {state.mode === "encode"
                          ? copy(
                              "Edit text to update the token breakdown.",
                              "编辑文本以更新Token分析。",
                            )
                          : copy(
                              "Paste token IDs to recover their decoded text.",
                              "粘贴Token ID以恢复解码文本。",
                            )}
                      </p>
                    </div>
                    <TabsList
                      className={styles.tabs}
                      aria-label={copy("Conversion mode", "转换模式")}
                    >
                      <TabsTab value="encode">
                        {copy("Text → tokens", "文本 → Token")}
                      </TabsTab>
                      <TabsTab value="decode">
                        {copy("Tokens → text", "Token → 文本")}
                      </TabsTab>
                    </TabsList>
                  </div>
                  <Field
                    className={styles.inputField}
                    label={copy(
                      state.mode === "encode"
                        ? "Text to tokenize"
                        : "Token IDs to decode",
                      state.mode === "encode" ? "待分词文本" : "待解码Token ID",
                    )}
                    error={errorText}
                  >
                    {(props) => (
                      <Textarea
                        {...props}
                        ref={editor}
                        className={styles.editor}
                        rows={7}
                        value={input}
                        readOnly={readonly}
                        placeholder={
                          state.mode === "encode"
                            ? copy("Type or paste text…", "输入或粘贴文本…")
                            : "[13225, 11, 2375, 0]"
                        }
                        onChange={(event) => {
                          const value = event.target.value
                          setState((before) => ({
                            ...before,
                            [before.mode === "encode" ? "text" : "ids"]: value,
                          }))
                          setNotice("")
                        }}
                        onSelect={rememberEditor}
                        onBlur={rememberEditor}
                        onScroll={rememberEditor}
                      />
                    )}
                  </Field>
                  <div className={styles.inputFooter}>
                    {state.mode === "encode" ? (
                      <ApSelect
                        label={copy("Load example", "加载示例")}
                        value={state.example}
                        disabled={readonly}
                        onChange={(value) => {
                          const example = tokenizerExamples.find(
                            (entry) => entry.id === value,
                          )
                          if (example)
                            setState((before) => ({
                              ...before,
                              text: example.text,
                              example: value,
                            }))
                        }}
                        options={tokenizerExamples.map((entry) => ({
                          value: entry.id,
                          label: en
                            ? entry.label
                            : {
                                support: "支持提示词",
                                code: "代码",
                                multilingual: "多语言",
                                structured: "结构化数据",
                              }[entry.id],
                        }))}
                      />
                    ) : (
                      <span className={styles.muted}>
                        {copy(
                          "JSON array or comma-separated IDs",
                          "JSON数组或逗号分隔的ID",
                        )}
                      </span>
                    )}
                    <div className={styles.counter}>
                      <span>
                        {number(input.length)} /{" "}
                        {number(
                          state.mode === "encode"
                            ? tokenizerLimits.text
                            : tokenizerLimits.idsText,
                        )}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={readonly || !input}
                        onClick={() =>
                          setState((before) => ({
                            ...before,
                            [before.mode === "encode" ? "text" : "ids"]: "",
                          }))
                        }
                      >
                        {copy("Clear", "清空")}
                      </Button>
                    </div>
                  </div>
                </Tabs>
              </Card>
              <Card
                className={styles.card}
                aria-labelledby="tokenizer-breakdown-heading"
              >
                <div className={styles.cardHeading}>
                  <div>
                    <h2 id="tokenizer-breakdown-heading">
                      {copy("Token breakdown", "Token分析")}
                    </h2>
                    <p>
                      {copy(
                        "Hover or focus a token to inspect its ID and bytes.",
                        "悬停或聚焦Token以检查ID和字节。",
                      )}
                    </p>
                  </div>
                  <label className={styles.whitespace}>
                    <Switch
                      checked={state.whitespace}
                      onCheckedChange={(value) =>
                        setState((before) => ({ ...before, whitespace: value }))
                      }
                    />
                    <span>{copy("Show whitespace", "显示空白")}</span>
                  </label>
                </div>
                <Tabs
                  value={state.output}
                  onValueChange={(value) =>
                    setState((before) => ({
                      ...before,
                      output: value as TokenizerOutput,
                    }))
                  }
                >
                  <TabsList
                    className={styles.tabs}
                    aria-label={copy("Output format", "输出格式")}
                  >
                    <TabsTab value="text">{copy("Text", "文本")}</TabsTab>
                    <TabsTab value="ids">
                      {copy("Token IDs", "Token ID")}
                    </TabsTab>
                    <TabsTab value="json">JSON</TabsTab>
                  </TabsList>
                  {busy ? (
                    <div
                      className={styles.resultState}
                      role="status"
                      aria-busy="true"
                    >
                      <LoaderCircle aria-hidden="true" size={16} />
                      <p>
                        {copy(
                          "Loading encoding and tokenizing…",
                          "正在加载编码器并分词…",
                        )}
                      </p>
                      <Button variant="ghost" size="sm" onClick={cancel}>
                        <X size={14} aria-hidden="true" />
                        {copy("Cancel", "取消")}
                      </Button>
                      {state.fault === "loading" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setState((before) => ({ ...before, fault: "none" }))
                          }
                        >
                          {copy("Load encoding", "加载编码器")}
                        </Button>
                      )}
                    </div>
                  ) : errorText ? (
                    <div className={styles.resultState} role="alert">
                      <Search aria-hidden="true" size={24} />
                      <h3>
                        {copy("Could not process this input", "无法处理此输入")}
                      </h3>
                      <p>{errorText}</p>
                      {job.error?.code === "engine" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setState((before) => ({ ...before, fault: "none" }))
                            setRetry((before) => before + 1)
                          }}
                        >
                          {copy("Retry loading", "重试加载")}
                        </Button>
                      )}
                    </div>
                  ) : job.cancelled ? (
                    <div className={styles.resultState} role="status">
                      <p>
                        {copy(
                          "Calculation cancelled. Your draft is preserved.",
                          "计算已取消，草稿已保留。",
                        )}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRetry((before) => before + 1)}
                      >
                        {copy("Calculate", "重新计算")}
                      </Button>
                    </div>
                  ) : (
                    result && (
                      <>
                        <TabsPanel
                          value="text"
                          keepMounted
                          className={styles.preview}
                          data-tokenizer-text
                        >
                          {result.pieces.length === 0 ? (
                            <p className={styles.empty}>
                              {copy(
                                "Enter text or token IDs to see a breakdown.",
                                "输入文本或Token ID以查看分析。",
                              )}
                            </p>
                          ) : (
                            <div className={styles.pieces}>
                              {result.pieces
                                .slice(0, visibleCount)
                                .map((entry, index) => (
                                  <Button
                                    key={
                                      entry.position + ":" + entry.ids.join(",")
                                    }
                                    className={styles.piece}
                                    variant="ghost"
                                    aria-pressed={piece === entry}
                                    aria-label={copy(
                                      "Inspect token " +
                                        (entry.position + 1) +
                                        ", IDs " +
                                        entry.ids.join(", "),
                                      "检查第" +
                                        (entry.position + 1) +
                                        "个Token，ID " +
                                        entry.ids.join(", "),
                                    )}
                                    onClick={() =>
                                      setState((before) => ({
                                        ...before,
                                        selected: index,
                                      }))
                                    }
                                    onFocus={() =>
                                      setState((before) => ({
                                        ...before,
                                        selected: index,
                                      }))
                                    }
                                    onMouseEnter={() =>
                                      setState((before) => ({
                                        ...before,
                                        selected: index,
                                      }))
                                    }
                                  >
                                    {state.whitespace
                                      ? showWhitespace(entry.text)
                                      : entry.text}
                                  </Button>
                                ))}
                            </div>
                          )}
                          {result.pieces.length > visibleCount && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setVisibleCount((before) => before + 500)
                              }
                            >
                              {copy("Show 500 more pieces", "再显示500个片段")}{" "}
                              ({number(visibleCount)} /{" "}
                              {number(result.pieces.length)})
                            </Button>
                          )}
                          {piece && (
                            <div
                              className={styles.tokenDetail}
                              role="group"
                              aria-label={copy(
                                "Selected token details",
                                "已选Token详情",
                              )}
                            >
                              <code>{JSON.stringify(piece.text)}</code>
                              <span>
                                {copy("ID", "ID")}{" "}
                                <code>{piece.ids.join(", ")}</code>{" "}
                                <span>UTF-8</span> <code>{hex}</code>
                              </span>
                            </div>
                          )}
                        </TabsPanel>
                        <TabsPanel
                          value="ids"
                          keepMounted
                          className={styles.outputPanel}
                        >
                          <Textarea
                            readOnly
                            aria-label={copy(
                              "Token IDs output",
                              "Token ID输出",
                            )}
                            className={styles.snapshot}
                            value={idsJson}
                            rows={4}
                          />
                        </TabsPanel>
                        <TabsPanel
                          value="json"
                          keepMounted
                          className={styles.outputPanel}
                        >
                          <Textarea
                            readOnly
                            aria-label={copy(
                              "Analysis JSON output",
                              "分析JSON输出",
                            )}
                            className={styles.snapshot + " " + styles.json}
                            value={json}
                            rows={8}
                          />
                        </TabsPanel>
                      </>
                    )
                  )}
                </Tabs>
                <div className={styles.analysisFooter}>
                  <p className={styles.muted}>
                    {copy(
                      "Some Unicode characters span multiple tokens. Their fragments are grouped into one readable piece.",
                      "部分Unicode字符跨越多个Token。其字节片段会合并为可读片段。",
                    )}
                  </p>
                  <div className={styles.copyActions}>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!result || copying}
                      onClick={() => void copyResult("ids")}
                    >
                      <Copy size={14} aria-hidden="true" />
                      {copy("Copy IDs", "复制ID")}
                    </Button>
                    {state.output === "json" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!result || copying}
                        onClick={() => void copyResult("json")}
                      >
                        <Copy size={14} aria-hidden="true" />
                        {copy("Copy JSON", "复制JSON")}
                      </Button>
                    )}
                  </div>
                  <p role="status" className={styles.notice}>
                    {notice}
                  </p>
                </div>
              </Card>
            </div>
            <div className={styles.details}>
              <Card className={styles.card}>
                <div className={styles.cardHeading}>
                  <div>
                    <h2>{copy("Selected piece", "已选片段")}</h2>
                    <p>
                      {copy(
                        "Explore the text behind a token.",
                        "探索Token背后的文本。",
                      )}
                    </p>
                  </div>
                </div>
                {piece ? (
                  <>
                    <pre className={styles.selectedText}>
                      {JSON.stringify(piece.text)}
                    </pre>
                    <dl className={styles.definition}>
                      <div>
                        <dt>{copy("Position", "位置")}</dt>
                        <dd>{number(piece.position + 1)}</dd>
                      </div>
                      <div>
                        <dt>{copy("Tokens in piece", "片段内Token数")}</dt>
                        <dd>{number(piece.ids.length)}</dd>
                      </div>
                      <div>
                        <dt>{copy("Token IDs", "Token ID")}</dt>
                        <dd>{piece.ids.join(", ")}</dd>
                      </div>
                      <div>
                        <dt>{copy("Decoded UTF-8 bytes", "解码UTF-8字节")}</dt>
                        <dd>{hex}</dd>
                      </div>
                    </dl>
                  </>
                ) : (
                  <p className={styles.muted}>
                    {copy(
                      "Choose a piece in the token preview.",
                      "在Token预览中选择一个片段。",
                    )}
                  </p>
                )}
              </Card>
              <div className={styles.budgetColumn}>
                <Card className={styles.card}>
                  <div className={styles.cardHeading}>
                    <div>
                      <h2>{copy("Prompt budget", "提示词预算")}</h2>
                      <p>
                        {copy(
                          "Compare this text against your own token limit.",
                          "将此文本与自己的Token上限比较。",
                        )}
                      </p>
                    </div>
                  </div>
                  <Field
                    className={styles.budgetField}
                    label={copy("Token budget", "Token预算")}
                    error={
                      !budgetValid
                        ? copy(
                            "Enter an integer budget between 1 and 10,000,000.",
                            "请输入1到10,000,000之间的整数预算。",
                          )
                        : undefined
                    }
                  >
                    {(props) => (
                      <Input
                        {...props}
                        type="number"
                        min={1}
                        max={10_000_000}
                        step={1}
                        readOnly={readonly}
                        value={state.budget}
                        onChange={(event) =>
                          setState((before) => ({
                            ...before,
                            budget: event.target.value,
                          }))
                        }
                      />
                    )}
                  </Field>
                  <Progress
                    className={styles.progress}
                    aria-label={copy("Token budget used", "已用Token预算")}
                    value={
                      result && budgetValid
                        ? Math.min(100, (result.tokenCount / budget) * 100)
                        : null
                    }
                  />
                  <p className={styles.budgetRemaining}>
                    {result && budgetValid
                      ? result.tokenCount <= budget
                        ? copy(
                            number(budget - result.tokenCount) +
                              " tokens remaining",
                            "剩余" +
                              number(budget - result.tokenCount) +
                              "个Token",
                          )
                        : copy(
                            number(result.tokenCount - budget) +
                              " tokens over budget",
                            "超出预算" +
                              number(result.tokenCount - budget) +
                              "个Token",
                          )
                      : result
                        ? copy(
                            "Enter a valid budget to calculate remaining tokens.",
                            "请输入有效预算以计算剩余Token。",
                          )
                        : copy("Waiting for token count…", "等待Token计数…")}
                  </p>
                  <p className={styles.muted}>
                    {copy(
                      "This covers plain text. Message formatting, tools, and generated output use additional tokens in an API request.",
                      "仅计算纯文本。API请求中的消息格式、工具和生成输出会额外消耗Token。",
                    )}
                  </p>
                </Card>
              </div>
              <p className={styles.muted + " " + styles.powered}>
                {copy("Powered by ", "基于 ")}
                <a
                  href="https://github.com/niieani/gpt-tokenizer"
                  target="_blank"
                  rel="noreferrer"
                >
                  gpt-tokenizer
                </a>
                {copy(
                  ". Your text is processed in a browser worker. Special token strings are treated as ordinary text.",
                  "。文本由浏览器Worker处理，特殊Token字符串按普通文本编码。",
                )}
              </p>
            </div>
          </div>
        </div>
      </ApPage>
    </div>
  )
}
