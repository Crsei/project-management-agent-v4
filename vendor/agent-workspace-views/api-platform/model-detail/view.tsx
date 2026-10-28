"use client"
import { useLayoutEffect, useRef, type ReactNode } from "react"
import { ArrowLeft, ArrowRight, Copy } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Switch } from "@easyuse-ui/ui/components/ui/switch"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import {
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel,
} from "@easyuse-ui/ui/components/ui/tabs"
import { CodePreview } from "@easyuse-ui/ui/components/blocks/code-preview"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { ApPage, ApSelect, ApModelIdentity, ApPriceText } from "../shared"
import { useApState } from "../state"
import {
  apAsOf,
  apFixtureRevision,
  capabilityCopy,
  modalityCopy,
  type ApLocale,
  type ApScenario,
} from "../model"
import {
  detailInputParameters,
  detailInputSchema,
  detailOutputParameters,
  detailPreset,
  detailPresets,
  type DetailParameterDoc,
} from "./fixtures"
import {
  applyPreset,
  createDetailState,
  draftFor,
  executionState,
  requestSnippet,
  responseJson,
  responseOutputText,
  validateDraft,
  withDraft,
  type DetailExecution,
  type DetailLanguage,
  type DetailNotice,
  type DetailReferenceTab,
  type DetailResponseTab,
  type DetailState,
} from "./controller"

const schemaJson = JSON.stringify(detailInputSchema(), null, 2)

function parameterLabel(doc: DetailParameterDoc): ReactNode {
  return (
    <>
      {doc.name}{" "}
      <span className="font-normal text-muted-foreground">{doc.type}</span>
    </>
  )
}
/** Reference-only parameter row (no control): name, type and contract description. */
function ParameterDocRow({
  doc,
  locale,
}: {
  doc: DetailParameterDoc
  locale: ApLocale
}) {
  return (
    <div className="border-b py-3" data-ap-parameter-doc={doc.name}>
      <p className="mb-1 text-[13px] font-medium">
        <code>{doc.name}</code>{" "}
        <span className="font-normal text-muted-foreground">{doc.type}</span>
        {doc.required && (
          <Badge size="sm" className="ml-2 align-middle">
            {locale === "en" ? "Required" : "必填"}
          </Badge>
        )}
      </p>
      <p className="text-xs leading-5 text-muted-foreground">
        {doc.description[locale]}
      </p>
    </div>
  )
}
export function ModelDetailView({
  scenario,
  modelId,
  onModelChange,
  onOpenCatalog,
  onOpenPricing,
}: {
  scenario: ApScenario
  modelId?: string
  onModelChange?: (modelId: string) => void
  onOpenCatalog?: () => void
  onOpenPricing?: () => void
}) {
  const { locale } = useI18n(),
    en = locale === "en"
  const [state, setState] = useApState("model-detail", () =>
    createDetailState(scenario, modelId),
  )
  // Explicit host identity also overrides a restored scenario on first mount.
  useLayoutEffect(() => {
    if (modelId !== undefined)
      setState((s) =>
        s.selectedId === modelId
          ? s
          : { ...s, selectedId: modelId, notice: "idle" },
      )
  }, [modelId, setState])
  const choose = <K extends keyof DetailState>(key: K, value: DetailState[K]) =>
    setState((s) => ({ ...s, [key]: value }))
  async function copyText(notice: DetailNotice, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      choose("notice", notice)
    } catch {
      choose("notice", "copy-error")
    }
  }
  const model = state.models.find((m) => m.modelId === state.selectedId) ?? null
  const draft = draftFor(state, state.selectedId)
  const errors = validateDraft(draft, model, en)
  const execution = executionState(state, scenario, model, errors, en)
  const paramsValid = !errors.maxTokens && !errors.stream
  /** Valid request parameters plus the fixed response fixture; neither is executed. */
  const example =
    model && paramsValid
      ? {
          snippet: requestSnippet(model, draft, state.language),
          json: responseJson(model, draft),
        }
      : null
  const loading = scenario === "loading" && !state.recovered
  const readonly = scenario === "readonly"
  const unknown = en ? "Unknown" : "未知"
  const noticeTexts: Record<DetailNotice, string> = {
    idle: "",
    "copied-id": en ? "Model ID copied." : "已复制模型 ID。",
    "copied-code": en ? "Request code copied." : "已复制请求代码。",
    "copied-response": en ? "Sample response copied." : "已复制示例响应。",
    "copied-schema": en ? "JSON schema copied." : "已复制 JSON Schema。",
    "copy-error": en
      ? "Clipboard unavailable; select the text and copy manually."
      : "剪贴板不可用，请选择文本手动复制。",
  }
  const pickerOptions = [
    ...(model === null && state.selectedId
      ? [
          {
            value: state.selectedId,
            label: `${en ? "Missing" : "未找到"} · ${state.selectedId}`,
          },
        ]
      : []),
    ...state.models.map((m) => ({ value: m.modelId, label: m.name })),
  ]
  const selectModel = (id: string) => {
    if (id === state.selectedId) return
    setState((s) => ({ ...s, selectedId: id, notice: "idle" }))
    onModelChange?.(id)
  }
  const pickerRef = useRef<HTMLDivElement>(null)
  const specRows: [string, ReactNode][] = model
    ? [
        [
          en ? "Context window" : "上下文窗口",
          model.contextTokens === null
            ? unknown
            : `${model.contextTokens.toLocaleString(locale)} ${en ? "tokens" : "Token"}`,
        ],
        [en ? "Modality" : "模态", modalityCopy[model.modality][locale]],
        [
          en ? "Availability" : "可用性",
          model.status === "available"
            ? en
              ? "Available"
              : "可用"
            : en
              ? "Unavailable"
              : "不可用",
        ],
        [en ? "Released" : "发布", `${model.releasedAt} · UTC`],
        [
          en ? "Latency" : "延迟",
          model.latencyMs === null ? unknown : `${model.latencyMs} ms`,
        ],
        [
          en ? "Privacy" : "隐私",
          `ZDR ${
            model.zeroRetention === null
              ? unknown
              : model.zeroRetention
                ? en
                  ? "Yes"
                  : "是"
                : en
                  ? "No"
                  : "否"
          } · ${en ? "No training" : "不训练"} ${
            model.noTraining === null
              ? unknown
              : model.noTraining
                ? en
                  ? "Yes"
                  : "是"
                : en
                  ? "No"
                  : "否"
          }`,
        ],
      ]
    : []
  /** Response region: explicit fixture sample load plus blocked/paused/failed states. */
  function renderResponse(): ReactNode {
    let kind: DetailExecution["kind"],
      source = "",
      content: ReactNode
    if (execution.kind === "idle") {
      kind = "idle"
      content = (
        <div className="rounded-control border bg-surface p-4">
          <p className="text-sm">
            {en
              ? "Load the fixture sample response for the current parameters."
              : "为当前参数加载本地 fixture 示例响应。"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {en
              ? "Local fixture only; no provider request is sent."
              : "仅使用本地 fixture，不向任何提供商发送请求。"}
          </p>
          <Button
            className="mt-3"
            onClick={() =>
              setState((s) => ({
                ...s,
                notice: "idle",
                sample: scenario === "refresh-error" ? "failed" : "loaded",
              }))
            }
          >
            {en ? "Load sample response" : "加载示例响应"}
          </Button>
        </div>
      )
    } else if (execution.kind !== "ready") {
      kind = execution.kind
      content = (
        <DataRegion
          state="error"
          hasContent={false}
          error={{
            category:
              execution.kind === "invalid"
                ? "validation"
                : execution.kind === "blocked" && scenario === "readonly"
                  ? "permission"
                  : "request",
            message: execution.message,
            reason: execution.reason,
          }}
          onRetry={
            execution.kind === "failed"
              ? () =>
                  setState((s) => ({
                    ...s,
                    notice: "idle",
                    sample: "loaded",
                  }))
              : undefined
          }
        />
      )
    } else if (example) {
      kind = "ready"
      source =
        state.responseTab === "output"
          ? responseOutputText(draft)
          : example.json
      content = (
        <>
          <TabsPanel value="output" className="pt-0">
            <div className="select-text whitespace-pre-wrap rounded-control border bg-surface p-4 text-sm leading-6">
              {responseOutputText(draft)}
            </div>
          </TabsPanel>
          <TabsPanel value="json" className="pt-0">
            <CodePreview
              identity="model-detail-response-json"
              code={example.json}
              language="javascript"
              ariaLabel={en ? "Sample response JSON" : "示例响应 JSON"}
            />
          </TabsPanel>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge tone="neutral">
              {en ? "Local fixture" : "本地 fixture"}
            </Badge>
            <span>
              {en
                ? "Fixed fixture content and recorded usage · No API request is sent"
                : "固定样例及记录用量 · 未发送 API 请求"}
            </span>
            <span className="ml-auto">{apAsOf.slice(0, 10)} · UTC</span>
          </div>
        </>
      )
    } else {
      return null
    }
    return (
      <div
        data-ap-detail-region="response"
        aria-labelledby="ap-detail-response-heading"
        className="mt-6"
      >
        <Tabs
          value={state.responseTab}
          onValueChange={(value) =>
            choose("responseTab", value as DetailResponseTab)
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3
              id="ap-detail-response-heading"
              className="text-sm font-semibold"
            >
              {en ? "Response" : "响应"}
            </h3>
            {kind === "ready" && example && (
              <div className="flex flex-wrap items-center gap-2">
                <TabsList aria-label={en ? "Response view" : "响应视图"}>
                  <TabsTab value="output">{en ? "Output" : "输出"}</TabsTab>
                  <TabsTab value="json">JSON</TabsTab>
                </TabsList>
                <Button
                  variant="outline"
                  aria-label={en ? "Copy sample response" : "复制示例响应"}
                  onClick={() =>
                    example &&
                    void copyText(
                      "copied-response",
                      state.responseTab === "output"
                        ? responseOutputText(draft)
                        : example.json,
                    )
                  }
                >
                  <Copy aria-hidden="true" />
                  {en ? "Copy sample response" : "复制示例响应"}
                </Button>
              </div>
            )}
          </div>
          <div
            className="mt-3"
            data-ap-sample-state={kind}
            data-ap-response-source={source}
          >
            {content}
          </div>
        </Tabs>
      </div>
    )
  }
  let body: ReactNode
  if (loading)
    body = (
      <>
        <DataRegion
          state="loading"
          hasContent={false}
          loadingLabel={en ? "Loading model details" : "正在加载模型详情"}
        />
        <Button
          className="mt-4"
          variant="secondary"
          onClick={() => choose("recovered", true)}
        >
          {en ? "Complete simulated load" : "完成模拟加载"}
        </Button>
      </>
    )
  else if (!model)
    body = (
      <section
        data-ap-detail-region="unknown"
        aria-labelledby="ap-detail-unknown-heading"
        className="relative max-w-2xl"
      >
        <h2 id="ap-detail-unknown-heading" className="sr-only">
          {en ? "Model lookup" : "模型查找"}
        </h2>
        {state.models.length === 0 ? (
          <DataRegion
            state="empty"
            emptyTitle={en ? "No models in this scene" : "本场景没有模型"}
            emptyDescription={
              en
                ? "This scene ships an empty fixture. Switch scenarios to open a model detail."
                : "本场景的 fixture 为空，请切换场景后查看模型详情。"
            }
          />
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {en ? "Requested model ID" : "请求的模型 ID"}
            </p>
            <code
              data-ap-unknown-model
              className="mt-1 block select-text break-all rounded-control border bg-surface px-3 py-2 text-xs"
            >
              {state.selectedId}
            </code>
            <div className="mt-4">
              <DataRegion
                state="empty"
                emptyTitle={en ? "Model not found" : "未找到该模型"}
                emptyDescription={
                  en
                    ? "This ID is not part of the scene's local fixture. Choose another model above to continue."
                    : "该 ID 不在本场景的本地 fixture 中，请在上方选择其它模型继续。"
                }
                emptyAction={
                  <Button
                    variant="outline"
                    onClick={() =>
                      pickerRef.current?.querySelector("button")?.focus()
                    }
                  >
                    {en ? "Choose another model" : "选择其它模型"}
                  </Button>
                }
              />
            </div>
          </>
        )}
      </section>
    )
  else
    body = (
      <>
        <section
          data-ap-detail-region="identity"
          aria-labelledby="ap-detail-identity-heading"
          className="relative border-b pb-6"
        >
          <h2 id="ap-detail-identity-heading" className="sr-only">
            {en ? "Model identity" : "模型身份"}
          </h2>
          <ApModelIdentity model={model} detail />
          <div className="mt-2 flex items-center gap-1">
            <code
              data-ap-model-id
              className="min-w-0 select-text break-all text-xs"
            >
              {model.modelId}
            </code>
            <Button
              variant="ghost"
              size="icon"
              aria-label={en ? "Copy model ID" : "复制模型 ID"}
              onClick={() => void copyText("copied-id", model.modelId)}
            >
              <Copy aria-hidden="true" />
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {model.capabilities === null ? (
              <Badge tone="warning">
                {en ? "Capabilities unknown" : "能力未知"}
              </Badge>
            ) : (
              model.capabilities.map((capability) => (
                <Badge key={capability} tone="neutral">
                  {capabilityCopy[capability][locale]}
                </Badge>
              ))
            )}
          </div>
        </section>
        <div className="mt-6 flex flex-col gap-8 xl:flex-row xl:items-start">
          <div className="min-w-0 flex-1 space-y-8">
            <section
              data-ap-detail-region="presets"
              aria-labelledby="ap-detail-quickstart-heading"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2
                  id="ap-detail-quickstart-heading"
                  className="text-base font-semibold"
                >
                  {en ? "Quick start" : "快速开始"}
                </h2>
                <span className="text-xs text-muted-foreground">
                  {en ? "Sample requests & responses" : "样例请求与响应"}
                </span>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {detailPresets.map((preset) => (
                  <Button
                    key={preset.id}
                    variant="outline"
                    className="min-h-20 w-full flex-col items-start gap-1 p-3 text-left"
                    aria-pressed={draft.presetId === preset.id}
                    data-ap-preset={preset.id}
                    disabled={readonly}
                    onClick={() =>
                      setState((s) =>
                        applyPreset(s, state.selectedId, preset.id),
                      )
                    }
                  >
                    <span className="text-[13px] font-medium">
                      {preset.name[locale]}
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {preset.description[locale]}
                    </span>
                  </Button>
                ))}
              </div>

              <div
                data-ap-detail-region="request"
                aria-labelledby="ap-detail-request-heading"
                className="mt-6"
              >
                <Tabs
                  value={state.language}
                  onValueChange={(value) =>
                    choose("language", value as DetailLanguage)
                  }
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3
                      id="ap-detail-request-heading"
                      className="text-sm font-semibold"
                    >
                      {en ? "Request" : "请求"}
                    </h3>
                    <div className="flex flex-wrap items-center gap-2">
                      <TabsList
                        aria-label={en ? "Request language" : "请求语言"}
                      >
                        <TabsTab value="curl">cURL</TabsTab>
                        <TabsTab value="javascript">JavaScript</TabsTab>
                        <TabsTab value="python">Python</TabsTab>
                      </TabsList>
                      <Button
                        variant="outline"
                        aria-label={en ? "Copy request code" : "复制请求代码"}
                        disabled={!example}
                        onClick={() =>
                          example &&
                          void copyText("copied-code", example.snippet)
                        }
                      >
                        <Copy aria-hidden="true" />
                        {en ? "Copy request code" : "复制请求代码"}
                      </Button>
                    </div>
                  </div>
                  <TabsPanel value={state.language} className="mt-3 pt-0">
                    {example ? (
                      <div data-ap-request-snippet={example.snippet}>
                        <Textarea
                          readOnly
                          rows={10}
                          aria-label={
                            en ? "Sample request code" : "样例请求代码"
                          }
                          className="w-full resize-none font-mono text-xs leading-5"
                          value={example.snippet}
                        />
                      </div>
                    ) : (
                      <DataRegion
                        state="error"
                        hasContent={false}
                        error={{
                          category: "validation",
                          message: en
                            ? "The request example is paused."
                            : "请求示例已暂停。",
                          reason: en
                            ? "Fix the invalid parameters to regenerate it."
                            : "修正无效参数后将重新生成。",
                        }}
                      />
                    )}
                  </TabsPanel>
                </Tabs>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {en
                    ? "Placeholders only: authentication is caller-supplied. Set API_AUTH_HEADER (cURL) or the API_AUTH_HEADERS JSON (JavaScript/Python) with your workspace-approved headers, plus API_BASE_URL. Real keys are never displayed."
                    : "模板只含占位符：鉴权由调用方提供，请将工作区批准的请求头存入 API_AUTH_HEADER（cURL）或 API_AUTH_HEADERS JSON（JavaScript/Python），并设置 API_BASE_URL；页面不显示真实密钥。"}
                </p>
              </div>

              {renderResponse()}
            </section>

            <section
              data-ap-detail-region="reference"
              aria-labelledby="ap-detail-reference-heading"
            >
              <Tabs
                value={state.referenceTab}
                onValueChange={(value) =>
                  choose("referenceTab", value as DetailReferenceTab)
                }
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2
                    id="ap-detail-reference-heading"
                    className="text-base font-semibold"
                  >
                    {en ? "API reference" : "API 参考"}
                  </h2>
                  <TabsList
                    aria-label={en ? "API reference view" : "API 参考视图"}
                  >
                    <TabsTab value="parameters">
                      {en ? "Parameters" : "参数"}
                    </TabsTab>
                    <TabsTab value="schema">JSON schema</TabsTab>
                  </TabsList>
                </div>
                <TabsPanel value="parameters">
                  <div className="grid gap-x-8 md:grid-cols-2">
                    <div data-ap-parameter-form>
                      <h3 className="mb-1 text-sm font-semibold">
                        {en ? "Input" : "输入"}
                      </h3>
                      {detailInputParameters.map((doc) => {
                        const label = parameterLabel(doc)
                        if (doc.control === "messages")
                          return (
                            <div
                              key={doc.name}
                              className="border-b py-3"
                              data-ap-field={doc.name}
                            >
                              <Field
                                label={label}
                                required={doc.required}
                                description={doc.description[locale]}
                              >
                                {(props) => (
                                  <Textarea
                                    {...props}
                                    rows={4}
                                    readOnly
                                    className="font-mono text-xs"
                                    value={JSON.stringify(
                                      detailPreset(draft.presetId).messages,
                                      null,
                                      2,
                                    )}
                                  />
                                )}
                              </Field>
                            </div>
                          )
                        if (doc.control === "max-tokens")
                          return (
                            <div
                              key={doc.name}
                              className="border-b py-3"
                              data-ap-field={doc.name}
                            >
                              <Field
                                label={label}
                                required={doc.required}
                                description={doc.description[locale]}
                                error={errors.maxTokens}
                              >
                                {(props) => (
                                  <Input
                                    {...props}
                                    inputMode="numeric"
                                    autoComplete="off"
                                    value={draft.maxTokens}
                                    disabled={readonly}
                                    onChange={(event) =>
                                      setState((s) =>
                                        withDraft(s, state.selectedId, {
                                          maxTokens: event.target.value,
                                        }),
                                      )
                                    }
                                  />
                                )}
                              </Field>
                            </div>
                          )
                        if (doc.control === "system")
                          return (
                            <div
                              key={doc.name}
                              className="border-b py-3"
                              data-ap-field={doc.name}
                            >
                              <Field
                                label={label}
                                required={doc.required}
                                description={doc.description[locale]}
                              >
                                {(props) => (
                                  <Textarea
                                    {...props}
                                    rows={3}
                                    value={draft.system}
                                    disabled={readonly}
                                    onChange={(event) =>
                                      setState((s) =>
                                        withDraft(s, state.selectedId, {
                                          system: event.target.value,
                                        }),
                                      )
                                    }
                                  />
                                )}
                              </Field>
                            </div>
                          )
                        if (doc.control === "stream")
                          return (
                            <div
                              key={doc.name}
                              className="border-b py-3"
                              data-ap-field={doc.name}
                            >
                              <Field
                                label={label}
                                required={doc.required}
                                description={doc.description[locale]}
                                error={errors.stream}
                              >
                                {(props) => (
                                  <span className="flex items-center gap-3">
                                    <Switch
                                      id={props.id}
                                      aria-label="stream"
                                      aria-describedby={
                                        props["aria-describedby"]
                                      }
                                      aria-invalid={props["aria-invalid"]}
                                      checked={draft.stream}
                                      disabled={readonly}
                                      onCheckedChange={(checked) =>
                                        setState((s) =>
                                          withDraft(s, state.selectedId, {
                                            stream: checked,
                                          }),
                                        )
                                      }
                                    />
                                    <span className="text-xs tabular-nums text-muted-foreground">
                                      {draft.stream ? "true" : "false"}
                                    </span>
                                  </span>
                                )}
                              </Field>
                            </div>
                          )
                        return (
                          <ParameterDocRow
                            key={doc.name}
                            doc={doc}
                            locale={locale}
                          />
                        )
                      })}
                    </div>
                    <div>
                      <h3 className="mb-1 text-sm font-semibold">
                        {en ? "Output" : "输出"}
                      </h3>
                      {detailOutputParameters.map((doc) => (
                        <ParameterDocRow
                          key={doc.name}
                          doc={doc}
                          locale={locale}
                        />
                      ))}
                    </div>
                  </div>
                </TabsPanel>
                <TabsPanel value="schema">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {en ? "Input schema" : "输入 Schema"}
                    </span>
                    <Button
                      variant="outline"
                      aria-label={en ? "Copy JSON schema" : "复制 JSON Schema"}
                      onClick={() => void copyText("copied-schema", schemaJson)}
                    >
                      <Copy aria-hidden="true" />
                      {en ? "Copy JSON schema" : "复制 JSON Schema"}
                    </Button>
                  </div>
                  <div className="mt-2" data-ap-schema-source={schemaJson}>
                    <CodePreview
                      identity="model-detail-schema"
                      code={schemaJson}
                      language="javascript"
                      ariaLabel={en ? "Input JSON schema" : "输入 JSON Schema"}
                    />
                  </div>
                </TabsPanel>
              </Tabs>
            </section>
          </div>

          <aside
            className="w-full shrink-0 space-y-6 xl:w-72"
            aria-label={en ? "Model summary" : "模型摘要"}
          >
            <section
              data-ap-detail-region="pricing"
              aria-labelledby="ap-detail-pricing-heading"
            >
              <h2
                id="ap-detail-pricing-heading"
                className="text-sm font-semibold"
              >
                {en ? "Pricing" : "定价"}
              </h2>
              <dl className="mt-2 text-sm">
                <div className="flex items-center justify-between gap-3 border-b py-2">
                  <dt className="text-muted-foreground">
                    {en ? "Input" : "输入"}
                  </dt>
                  <dd>
                    <ApPriceText price={model.inputPrice} />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-b py-2">
                  <dt className="text-muted-foreground">
                    {en ? "Output" : "输出"}
                  </dt>
                  <dd>
                    <ApPriceText price={model.outputPrice} />
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {en ? "Fixture snapshot" : "本地 fixture 快照"}{" "}
                {apAsOf.slice(0, 10)} · UTC
              </p>
            </section>

            <section
              data-ap-detail-region="specs"
              aria-labelledby="ap-detail-specs-heading"
            >
              <h2
                id="ap-detail-specs-heading"
                className="text-sm font-semibold"
              >
                {en ? "Model specifications" : "模型规格"}
              </h2>
              <dl className="mt-2 text-sm">
                {specRows.map(([label, value]) => (
                  <div
                    key={label}
                    className="flex items-center justify-between gap-3 border-b py-2 last:border-b-0"
                  >
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="text-right tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {apFixtureRevision}
              </p>
            </section>

            {(onOpenCatalog || onOpenPricing) && (
              <section
                data-ap-detail-region="resources"
                aria-labelledby="ap-detail-resources-heading"
              >
                <h2
                  id="ap-detail-resources-heading"
                  className="text-sm font-semibold"
                >
                  {en ? "Resources" : "资源"}
                </h2>
                <div className="mt-2 flex flex-col gap-2">
                  {onOpenCatalog && (
                    <Button
                      variant="outline"
                      className="justify-between"
                      onClick={onOpenCatalog}
                    >
                      {en ? "Model catalog" : "模型目录"}
                      <ArrowRight aria-hidden="true" />
                    </Button>
                  )}
                  {onOpenPricing && (
                    <Button
                      variant="outline"
                      className="justify-between"
                      onClick={onOpenPricing}
                    >
                      {en ? "Model pricing" : "模型定价"}
                      <ArrowRight aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </section>
            )}
          </aside>
        </div>
      </>
    )
  return (
    <ApPage
      pageId="model-detail"
      title={en ? "Model details" : "模型详情"}
      description={
        en
          ? "Model parameters, JSON schema and consistent request and response samples."
          : "模型参数、JSON Schema 与一致的请求和响应样例。"
      }
      actions={
        onOpenCatalog ? (
          <Button variant="outline" onClick={onOpenCatalog}>
            <ArrowLeft aria-hidden="true" />
            {en ? "Model catalog" : "模型目录"}
          </Button>
        ) : undefined
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-3 border-b py-3">
          {(state.models.length > 0 || state.selectedId) && (
            <div data-ap-model-picker ref={pickerRef}>
              <ApSelect
                label={en ? "Select model" : "选择模型"}
                value={state.selectedId}
                onChange={selectModel}
                options={pickerOptions}
              />
            </div>
          )}
          <p role="status" className="text-sm">
            {noticeTexts[state.notice]}
          </p>
          <span className="ml-auto text-xs text-muted-foreground">
            {en ? "Local fixture · snapshot" : "本地 fixture · 快照"}{" "}
            {apAsOf.slice(0, 10)} · UTC
          </span>
        </div>
      }
    >
      {body}
    </ApPage>
  )
}
