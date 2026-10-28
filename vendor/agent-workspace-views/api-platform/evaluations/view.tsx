"use client"
import { useEffect, useLayoutEffect, useRef } from "react"
import {
  Download,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  Settings2,
  Trash2,
  Upload,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Switch } from "@easyuse-ui/ui/components/ui/switch"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import { Empty } from "@easyuse-ui/ui/components/ui/empty"
import {
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel,
} from "@easyuse-ui/ui/components/ui/tabs"
import {
  TableContainer,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "@easyuse-ui/ui/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@easyuse-ui/ui/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
} from "@easyuse-ui/ui/components/ui/sheet"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { ApPage, ApSelect, ApSearch } from "../shared"
import { useApCache, useApState } from "../state"
import { apScenarios, apScope, type ApScenario } from "../model"
import type { RemainingPageProps } from "../../showcase/model"
import { apModels } from "../fixtures/models"
import {
  checkEvaluation,
  createEvaluationState,
  evaluationCompatibility,
  evaluationMetrics,
  exportEvaluation,
  filteredEvaluations,
  importExamples,
  replaceDatasetExamples,
  saveExample,
  settleEvaluation,
  startEvaluation,
  type EvaluationState,
  type RunOutcome,
} from "./controller"
import type { EvaluationGrader, EvaluationRun } from "./fixtures"
import styles from "./evaluations.module.css"

function download(name: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type })),
    anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}
export const pageScenarios = apScenarios

export function RemainingPageView({ scenario, active }: RemainingPageProps) {
  return <EvaluationsView scenario={scenario as ApScenario} active={active} />
}

export function EvaluationsView({
  scenario,
  active = true,
}: {
  scenario: ApScenario
  active?: boolean
}) {
  const { locale } = useI18n(),
    en = locale === "en",
    copy = (english: string, chinese: string) => (en ? english : chinese)
  const [state, setState] = useApState("evaluations", () =>
    createEvaluationState(scenario),
  )
  const canWrite = scenario !== "readonly" && apScope.canWrite,
    loading = scenario === "loading" && !state.recovered
  const refreshError = scenario === "refresh-error" && !state.recovered
  const selected =
    state.runs.find((r) => r.evaluationId === state.selectedId) ?? null
  const dataset =
    state.datasets.find((d) => d.datasetId === state.datasetId) ?? null
  const runs = filteredEvaluations(state),
    datasets = state.datasets.filter((d) =>
      d.name.toLowerCase().includes(state.search.trim().toLowerCase()),
    )
  const cache = useApCache(),
    root = useRef<HTMLDivElement>(null)
  const createTrigger = useRef<HTMLButtonElement>(null)
  const dialogFocus = useRef<Record<string, HTMLElement | null>>({})
  const choose = <K extends keyof EvaluationState>(
    key: K,
    value: EvaluationState[K],
  ) => setState((s) => ({ ...s, [key]: value }))
  const patch = (values: Partial<EvaluationState>) =>
    setState((s) => ({ ...s, ...values }))
  const openModal = (key: string, values: Partial<EvaluationState>) => {
    dialogFocus.current[key] =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    patch(values)
  }
  useEffect(() => {
    if (!active || state.operation?.status !== "pending") return
    const timer = window.setTimeout(
      () => setState((s) => settleEvaluation(s)),
      450,
    )
    return () => window.clearTimeout(timer)
  }, [active, state.operation?.operationId, state.operation?.status, setState])
  useLayoutEffect(() => {
    const scroll = root.current?.querySelector<HTMLElement>("[data-ap-scroll]")
    if (active && scroll)
      scroll.scrollTop = Number(
        cache?.get("evaluations-scroll:" + state.tab) ?? 0,
      )
  }, [active, cache, state.tab])
  const changeTab = (value: string) => {
    const scroll = root.current?.querySelector<HTMLElement>("[data-ap-scroll]")
    cache?.set("evaluations-scroll:" + state.tab, scroll?.scrollTop ?? 0)
    patch({ tab: value, error: "" })
  }
  const statusLabel = (value: string) =>
    ({
      completed: copy("Completed", "已完成"),
      partial: copy("Partial", "部分评分"),
      failed: copy("Failed", "失败"),
      running: copy("Running", "运行中"),
      cancelled: copy("Cancelled", "已取消"),
    })[value] ?? value
  const resultBadge = (passed: boolean | null) => (
    <Badge
      className={styles.badge}
      tone={passed === null ? "neutral" : passed ? "success" : "danger"}
    >
      {passed === null
        ? copy("Ungraded", "未评")
        : passed
          ? copy("Passed", "通过")
          : copy("Failed", "未通过")}
    </Badge>
  )
  const runBadge = (run: EvaluationRun) => (
    <Badge
      className={styles.badge}
      tone={
        run.status === "completed"
          ? "success"
          : run.status === "failed"
            ? "danger"
            : "warning"
      }
    >
      <span className={styles.dot} aria-hidden="true" />
      {statusLabel(run.status)}
    </Badge>
  )
  const errorMessages: Record<string, string> = {
    name: copy("Enter an evaluation name.", "请输入评测名称。"),
    "empty-dataset": copy(
      "Choose a dataset containing at least one example.",
      "请选择至少包含一个样例的数据集。",
    ),
    "provider-incompatible": copy(
      "This provider is disabled or has no available text model. Configure a compatible provider first.",
      "提供商未启用或没有可用文本模型，请先配置兼容提供商。",
    ),
    rejected: copy(
      "Creation was rejected. Your draft and existing runs are preserved.",
      "创建被拒绝，草稿和已有运行均已保留。",
    ),
    unknown: copy(
      "Creation result is unknown. Do not resubmit; check the recorded operation.",
      "创建结果未知，请查询原操作，勿重复提交。",
    ),
    "example-required": copy(
      "Input and expected phrase are required.",
      "输入和预期短语不能为空。",
    ),
    "dataset-name": copy("Enter a dataset name.", "请输入数据集名称。"),
    "provider-invalid": copy(
      "Use an HTTPS endpoint and an available model from this provider.",
      "请使用 HTTPS 地址和该提供商的可用模型。",
    ),
    "import-invalid": copy(
      "Provide 1–500 JSONL records with input, expected and candidate (string or null). No changes were applied.",
      "请提供1–500条含 input、expected、candidate（字符串或null）的JSONL记录；未应用任何修改。",
    ),
  }
  const busy = state.operation?.status === "pending",
    unknown = state.operation?.status === "unknown"
  const notice = {
    created: copy("Local evaluation created.", "已创建本地评测。"),
    checked: copy(
      "Recorded operation confirmed. No request was replayed.",
      "原操作已确认，未重放请求。",
    ),
    versioned: copy(
      "New dataset version saved. Existing runs keep their original snapshot.",
      "已保存新版本，已有评测保留原始快照。",
    ),
    exported: copy("Fixture export downloaded.", "已下载样例导出。"),
    configured: copy(
      "Demo provider configuration saved. No endpoint was contacted.",
      "已保存样例提供商配置，未连接端点。",
    ),
    deleted: copy(
      "Dataset deleted; historical evaluation snapshots are preserved.",
      "已删除数据集，历史评测快照仍保留。",
    ),
    dataset: copy(
      "Dataset created. Add examples before running an evaluation.",
      "已创建数据集，请添加样例后再评测。",
    ),
  }[state.notice]
  const exportRun = (run: EvaluationRun) => {
    download(run.evaluationId + "-fixture.json", exportEvaluation(run))
    choose("notice", "exported")
  }
  const metricText = (run: EvaluationRun) => {
    const value = evaluationMetrics(run).percent
    return value === null ? copy("Unknown", "未知") : value + "%"
  }
  const dateText = (run: EvaluationRun) =>
    new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    }).format(new Date(run.createdAt))
  const openExample = (id: string | null) => {
    const example = dataset?.examples.find((e) => e.exampleId === id)
    openModal("example", {
      editingExampleId: id,
      exampleOpen: true,
      error: "",
      exampleDraft:
        state.editingExampleId === id
          ? state.exampleDraft
          : example
            ? { ...example }
            : { exampleId: "", input: "", expected: "", candidate: "" },
    })
  }
  const renderResults = (run: EvaluationRun) => {
    const metrics = evaluationMetrics(run),
      comparison = state.runs.find((r) => r.evaluationId === state.compareId),
      compatibility = comparison
        ? evaluationCompatibility(run, comparison)
        : null
    const results =
      run.results?.filter(
        (r) =>
          state.resultFilter === "all" ||
          (state.resultFilter === "passed"
            ? r.passed === true
            : state.resultFilter === "failed"
              ? r.passed === false
              : r.passed === null),
      ) ?? []
    return (
      <section
        aria-label={copy("Selected evaluation results", "所选评测结果")}
        className={styles.results}
      >
        <header className={styles.resultHeader}>
          <div>
            <h2>{run.name}</h2>
            <p>
              {run.dataset.name} · v{run.dataset.version} ·{" "}
              {state.providers.find((p) => p.providerId === run.providerId)
                ?.name ?? run.providerId}{" "}
              / {run.modelLabel}
            </p>
          </div>
          {runBadge(run)}
        </header>
        <div className={styles.resultBody}>
          <p className={styles.grader}>
            {run.grader === "contains"
              ? copy("Contains expected phrase", "包含预期短语")
              : copy("Exact match", "精确匹配")}{" "}
            · {copy("case insensitive", "不区分大小写")}
          </p>
          <div className={styles.metrics}>
            {[
              [copy("Pass rate", "通过率"), metricText(run)],
              [
                copy("Passed", "通过"),
                metrics.passed ?? copy("Unknown", "未知"),
              ],
              [
                copy("Failed", "未通过"),
                metrics.failed ?? copy("Unknown", "未知"),
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <p>{label}</p>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          {run.status === "partial" && (
            <p role="status" className={styles.coverage}>
              {copy("Partial scoring", "部分评分")} · {metrics.scored}/
              {metrics.total} {copy("scored examples", "已评样例")} ·{" "}
              {metrics.ungraded}{" "}
              {copy(
                "ungraded; pass rate denominator excludes ungraded examples.",
                "未评；通过率分母仅包含已评样例。",
              )}
            </p>
          )}
          {run.failure && (
            <p role="alert" className={styles.error}>
              {copy(run.failure, "本地评分中断，没有可用评分。")}
            </p>
          )}
          <div className={styles.resultToolbar}>
            <ApSelect
              label={copy("Evaluation result filter", "评测结果筛选")}
              value={state.resultFilter}
              onChange={(v) => choose("resultFilter", v)}
              options={[
                { value: "all", label: copy("All examples", "全部样例") },
                { value: "passed", label: copy("Passed only", "仅通过") },
                { value: "failed", label: copy("Failed only", "仅未通过") },
                { value: "ungraded", label: copy("Ungraded", "未评") },
              ]}
            />
            <Button variant="outline" size="sm" onClick={() => exportRun(run)}>
              {copy("Export results", "导出结果")}
            </Button>
          </div>
          {results.map((result) => (
            <article className={styles.exampleResult} key={result.exampleId}>
              <div className={styles.exampleTitle}>
                <h3>{result.input}</h3>
                {resultBadge(result.passed)}
              </div>
              <p className={styles.meta}>
                {run.grader === "contains"
                  ? copy("Expected phrase", "预期短语")
                  : copy("Expected answer", "预期答案")}
              </p>
              <p>{result.expected}</p>
              <p className={styles.meta}>
                {copy("Candidate output", "候选输出")}
              </p>
              <p>
                {result.candidate ??
                  copy("Missing candidate output", "候选输出缺失")}
              </p>
            </article>
          ))}
          {run.results !== null && results.length === 0 && (
            <p className={styles.empty}>
              {copy("No examples match this filter.", "没有符合筛选的样例。")}
            </p>
          )}
          <p className={styles.trace}>
            {copy("Dataset", "数据集")} {run.dataset.datasetId} · v
            {run.dataset.version} · {copy("Metric", "指标")} pass-rate ·{" "}
            {run.configVersion} · {metrics.scored ?? "?"}/{metrics.total}{" "}
            {copy("scored (UTC)", "已评（UTC）")}
            {run.modelId === null && (
              <>
                {" "}
                ·{" "}
                {copy(
                  "Historical model label; catalog reference unavailable",
                  "历史模型标签；目录引用不可用",
                )}
              </>
            )}
          </p>
          <div className={styles.compare}>
            <ApSelect
              label={copy("Compare evaluation", "对比评测")}
              value={state.compareId}
              onChange={(v) => choose("compareId", v)}
              options={[
                { value: "", label: copy("Compare with…", "选择对比评测…") },
                ...state.runs
                  .filter((r) => r.evaluationId !== run.evaluationId)
                  .map((r) => ({
                    value: r.evaluationId,
                    label: r.name + " · " + r.evaluationId,
                  })),
              ]}
            />
            {comparison && (
              <div role="status" data-comparison={compatibility}>
                {compatibility === "compatible" ? (
                  <>
                    <strong>
                      {run.name}: {metricText(run)} · {comparison.name}:{" "}
                      {metricText(comparison)}
                    </strong>
                    <p>
                      {copy(
                        "Same dataset, version, grader and scored denominator",
                        "相同数据集、版本、评分配置及已评分母",
                      )}{" "}
                      · {metrics.scored}/{metrics.total}
                    </p>
                    <TableContainer>
                      <Table>
                        <TableCaption className="sr-only">
                          {copy(
                            "Per-example evaluation comparison",
                            "逐样例评测对比",
                          )}
                        </TableCaption>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{copy("Example", "样例")}</TableHead>
                            <TableHead>{run.name}</TableHead>
                            <TableHead>{comparison.name}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {run.results?.map((result) => (
                            <TableRow key={result.exampleId}>
                              <TableCell>{result.input}</TableCell>
                              <TableCell>
                                {resultBadge(result.passed)}
                              </TableCell>
                              <TableCell>
                                {resultBadge(
                                  comparison.results!.find(
                                    (r) => r.exampleId === result.exampleId,
                                  )?.passed ?? null,
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  </>
                ) : (
                  <>
                    <strong>{copy("Not comparable", "不可直接比较")}</strong>
                    <p>
                      {
                        {
                          dataset: copy("Different datasets.", "数据集不同。"),
                          version: copy(
                            "Different dataset versions or example identities.",
                            "数据集版本或样例身份不同。",
                          ),
                          configuration: copy(
                            "Different grader configurations.",
                            "评分配置不同。",
                          ),
                          coverage: copy(
                            "Different scored denominators; ungraded examples are not zero.",
                            "已评分母不同；未评项不计为零。",
                          ),
                          unavailable: copy(
                            "Scores are unavailable.",
                            "评分不可用。",
                          ),
                        }[
                          compatibility as Exclude<
                            typeof compatibility,
                            "compatible" | null
                          >
                        ]
                      }{" "}
                      {comparison.name}: {metricText(comparison)}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </section>
    )
  }
  return (
    <div
      className={styles.page}
      ref={root}
      onScrollCapture={(event) => {
        const target = event.target
        if (
          active &&
          target instanceof HTMLElement &&
          target.hasAttribute("data-ap-scroll")
        )
          cache?.set("evaluations-scroll:" + state.tab, target.scrollTop)
      }}
    >
      <ApPage
        pageId="evaluations"
        variant="reference"
        contentWidth={1264}
        title={copy("Evaluations", "评测")}
        description={copy(
          "Build datasets, grade candidate answers, and compare quality across runs.",
          "构建数据集、评分候选答案，并比较各次运行的质量。",
        )}
        actions={
          <Button
            className={styles.create}
            ref={createTrigger}
            disabled={!canWrite || loading}
            onClick={() => patch({ createOpen: true, error: "" })}
          >
            <Plus size={14} />
            {copy("Create evaluation", "创建评测")}
          </Button>
        }
      >
        {!canWrite && (
          <p role="status" className={styles.notice}>
            {copy(
              "Read only: creation and configuration are disabled.",
              "只读：无法创建或修改配置。",
            )}
          </p>
        )}
        {notice && (
          <p role="status" className={styles.notice}>
            {notice}
          </p>
        )}
        {unknown && (
          <div className={styles.notice} role="status">
            <p>
              {errorMessages.unknown} · {state.operation!.operationId}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setState(checkEvaluation)}
            >
              {copy("Check operation", "查询操作")}
            </Button>
          </div>
        )}
        <Tabs
          value={state.tab}
          onValueChange={(value) => changeTab(String(value))}
        >
          <div className={styles.toolbar}>
            <TabsList className={styles.tabs}>
              <TabsTab value="evaluations">
                {copy("Evaluations", "评测")}
              </TabsTab>
              <TabsTab value="datasets">{copy("Datasets", "数据集")}</TabsTab>
              <TabsTab value="providers">{copy("Providers", "提供商")}</TabsTab>
            </TabsList>
            {state.tab !== "providers" && (
              <div className={styles.filters}>
                <div className={styles.search}>
                  <ApSearch
                    label={copy(
                      "Search evaluations or datasets",
                      "搜索评测或数据集",
                    )}
                    placeholder={
                      state.tab === "evaluations"
                        ? copy("Search evaluations…", "搜索评测…")
                        : copy("Search datasets…", "搜索数据集…")
                    }
                    value={state.search}
                    onChange={(value) => choose("search", value)}
                  />
                </div>
                {state.tab === "evaluations" ? (
                  <>
                    <ApSelect
                      label={copy(
                        "Evaluation provider filter",
                        "评测提供商筛选",
                      )}
                      value={state.provider}
                      onChange={(value) => choose("provider", value)}
                      options={[
                        {
                          value: "all",
                          label: copy("All providers", "全部提供商"),
                        },
                        ...state.providers.map((provider) => ({
                          value: provider.providerId,
                          label: provider.name,
                        })),
                      ]}
                    />
                    <ApSelect
                      label={copy("Evaluation status", "评测状态")}
                      value={state.status}
                      onChange={(v) => choose("status", v)}
                      options={[
                        {
                          value: "all",
                          label: copy("All statuses", "全部状态"),
                        },
                        ...[
                          "completed",
                          "running",
                          "cancelled",
                          "partial",
                          "failed",
                        ].map((v) => ({ value: v, label: statusLabel(v) })),
                      ]}
                    />
                  </>
                ) : (
                  <Button
                    variant="outline"
                    disabled={!canWrite || loading}
                    onClick={() =>
                      openModal("datasetCreate", {
                        datasetCreateOpen: true,
                        error: "",
                      })
                    }
                  >
                    <Plus size={14} />
                    {copy("New dataset", "新建数据集")}
                  </Button>
                )}
              </div>
            )}
          </div>
          <DataRegion
            state={loading ? "loading" : refreshError ? "error" : "success"}
            hasContent={!loading}
            error={
              refreshError
                ? {
                    category: "network",
                    message: copy("Refresh failed.", "刷新失败。"),
                    reason: copy(
                      "Existing fixture data and drafts are preserved.",
                      "已保留样例数据和草稿。",
                    ),
                  }
                : undefined
            }
            onRetry={() => choose("recovered", true)}
          >
            <TabsPanel value="evaluations" className={styles.panel}>
              {runs.length > 0 && (
                <TableContainer className={styles.table}>
                  <Table>
                    <TableCaption className="sr-only">
                      {copy("Evaluation runs", "评测运行")}
                    </TableCaption>
                    <colgroup>
                      {[18, 23, 19, 15, 10, 15].map((width, index) => (
                        <col key={index} style={{ width: width + "%" }} />
                      ))}
                    </colgroup>
                    <TableHeader>
                      <TableRow>
                        {[
                          copy("Evaluation", "评测"),
                          copy("Dataset", "数据集"),
                          copy("Model", "模型"),
                          copy("Status", "状态"),
                          copy("Pass rate", "通过率"),
                          copy("Created", "创建时间"),
                        ].map((label) => (
                          <TableHead key={label}>{label}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runs.map((run) => (
                        <TableRow
                          key={run.evaluationId}
                          data-selected={run.evaluationId === state.selectedId}
                        >
                          <TableCell>
                            <Button
                              variant="ghost"
                              className={styles.nameButton}
                              onClick={() =>
                                patch({
                                  selectedId: run.evaluationId,
                                  compareId: "",
                                })
                              }
                            >
                              {run.name}
                            </Button>
                            <p className={styles.meta}>{run.evaluationId}</p>
                          </TableCell>
                          <TableCell>
                            <p>{run.dataset.name}</p>
                            <p className={styles.meta}>
                              {copy("Version", "版本")} {run.dataset.version} ·{" "}
                              {run.dataset.examples.length}{" "}
                              {copy("examples", "样例")}
                            </p>
                          </TableCell>
                          <TableCell className={styles.model}>
                            {state.providers.find(
                              (p) => p.providerId === run.providerId,
                            )?.name ?? run.providerId}{" "}
                            / {run.modelLabel}
                          </TableCell>
                          <TableCell>{runBadge(run)}</TableCell>
                          <TableCell>{metricText(run)}</TableCell>
                          <TableCell className={styles.meta}>
                            {dateText(run)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
              {runs.length === 0 && (
                <Empty
                  className={styles.collectionEmpty}
                  icon={<Search size={24} aria-hidden="true" />}
                  title={
                    state.runs.length === 0
                      ? copy("No evaluations yet", "暂无评测")
                      : copy("No results found", "没有匹配结果")
                  }
                  description={
                    state.runs.length === 0
                      ? copy(
                          "Create a dataset and add examples to begin.",
                          "请创建数据集并添加样例。",
                        )
                      : copy(
                          "Try a different search or clear your filters.",
                          "请更改搜索或清除筛选。",
                        )
                  }
                  action={
                    state.runs.length > 0 ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          patch({ status: "all", provider: "all", search: "" })
                        }
                      >
                        {copy("Clear filters", "清除筛选")}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        disabled={!canWrite}
                        onClick={() =>
                          openModal("datasetCreate", {
                            tab: "datasets",
                            datasetCreateOpen: true,
                          })
                        }
                      >
                        {copy("New dataset", "新建数据集")}
                      </Button>
                    )
                  }
                />
              )}
              <p className={styles.footnote}>
                {copy(
                  "Runs grade the candidate outputs stored in your dataset. No model request is made.",
                  "运行只对数据集中已存储的候选输出评分，不发起模型请求。",
                )}
              </p>
              {selected && renderResults(selected)}
            </TabsPanel>
            <TabsPanel value="datasets" className={styles.panel}>
              <div className={styles.datasetGrid}>
                {datasets.map((item) => (
                  <article className={styles.datasetCard} key={item.datasetId}>
                    <div className={styles.cardTitle}>
                      <Button
                        variant="ghost"
                        className={styles.nameButton}
                        onClick={() =>
                          openModal("dataset", { datasetId: item.datasetId })
                        }
                      >
                        {item.name}
                      </Button>
                      <Badge className={styles.badge}>v{item.version}</Badge>
                    </div>
                    <p>{item.description}</p>
                    <footer>
                      <span>
                        {item.examples.length} {copy("examples", "样例")}
                      </span>
                      <Button
                        variant="outline"
                        onClick={() =>
                          openModal("dataset", { datasetId: item.datasetId })
                        }
                      >
                        {copy("Open dataset", "打开数据集")}
                      </Button>
                    </footer>
                  </article>
                ))}
              </div>
              {datasets.length === 0 && (
                <p className={styles.empty}>
                  {copy(
                    "No datasets found. Create a dataset or clear the search.",
                    "暂无数据集，请创建数据集或清除搜索。",
                  )}
                </p>
              )}
            </TabsPanel>
            <TabsPanel value="providers" className={styles.panel}>
              <div className={styles.providers}>
                <h2>{copy("Model providers", "模型提供商")}</h2>
                <p className={styles.providerDescription}>
                  {copy(
                    "Choose the provider labels available when creating an evaluation.",
                    "选择创建评测时可用的提供商标签。",
                  )}
                </p>
                {state.providers.map((provider) => (
                  <article
                    className={styles.providerRow}
                    key={provider.providerId}
                  >
                    <Settings2 size={20} aria-hidden="true" />
                    <div>
                      <h3>{provider.name}</h3>
                      <p>{provider.modelLabel}</p>
                    </div>
                    <Badge
                      className={styles.badge}
                      tone={provider.enabled ? "success" : "neutral"}
                    >
                      <span className={styles.dot} aria-hidden="true" />
                      {provider.enabled
                        ? copy("Ready", "就绪")
                        : copy("Disabled", "未启用")}
                    </Badge>
                    <Button
                      variant="outline"
                      disabled={!canWrite}
                      onClick={() =>
                        openModal("provider", {
                          providerOpen: true,
                          providerDraft:
                            state.providerDraft?.providerId ===
                            provider.providerId
                              ? state.providerDraft
                              : { ...provider },
                          error: "",
                        })
                      }
                    >
                      {copy("Configure", "配置")}
                    </Button>
                  </article>
                ))}
                <p className={styles.footnote}>
                  {copy(
                    "Demo configurations use no credentials and never contact provider endpoints.",
                    "样例配置不使用凭据，绝不连接提供商端点。",
                  )}
                </p>
              </div>
            </TabsPanel>
          </DataRegion>
        </Tabs>
        {loading && (
          <Button variant="outline" onClick={() => choose("recovered", true)}>
            {copy("Complete fixture load", "完成样例加载")}
          </Button>
        )}
        <details className={styles.fixtureControls}>
          <summary>{copy("Fixture controls", "样例控制")}</summary>
          <ApSelect
            label={copy("Evaluation provider filter", "评测提供商筛选")}
            value={state.provider}
            onChange={(value) => choose("provider", value)}
            options={[
              { value: "all", label: copy("All providers", "全部提供商") },
              ...state.providers.map((provider) => ({
                value: provider.providerId,
                label: provider.name,
              })),
            ]}
          />
          <ApSelect
            label={copy("Creation outcome", "创建结果")}
            value={state.outcome}
            onChange={(v) => choose("outcome", v as RunOutcome)}
            options={[
              { value: "confirmed", label: copy("Completed", "已完成") },
              { value: "partial", label: copy("Partial scoring", "部分评分") },
              { value: "failed", label: copy("Run failed", "运行失败") },
              {
                value: "rejected",
                label: copy("Creation rejected", "创建拒绝"),
              },
              { value: "unknown", label: copy("Creation unknown", "创建未知") },
            ]}
          />
          <p>
            {copy(
              "Local stored-output grading only. No credentials, provider requests or persistent writes.",
              "仅对本地存储输出评分；无凭据、模型请求或持久化写入。",
            )}
          </p>
        </details>
        <Dialog
          open={active && state.createOpen}
          onOpenChange={(open) => {
            if (!busy) choose("createOpen", open)
          }}
        >
          <DialogContent className={styles.dialog} finalFocus={createTrigger}>
            <DialogTitle>{copy("Create evaluation", "创建评测")}</DialogTitle>
            <DialogDescription>
              {copy(
                "Run a local grader against stored candidate outputs. Provider selection labels the run.",
                "对已存储候选输出执行本地评分，提供商选择仅标记运行。",
              )}
            </DialogDescription>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                setState((s) => startEvaluation(s, canWrite))
              }}
              className={styles.form}
            >
              <Field
                label={copy("Name", "名称")}
                error={state.error === "name" ? errorMessages.name : undefined}
              >
                {(props) => (
                  <Input
                    {...props}
                    autoFocus
                    placeholder={copy("Support quality check", "支持质量检查")}
                    value={state.runDraft.name}
                    disabled={busy || unknown || !canWrite}
                    onChange={(e) =>
                      choose("runDraft", {
                        ...state.runDraft,
                        name: e.target.value,
                      })
                    }
                  />
                )}
              </Field>
              <div>
                <label className={styles.fieldLabel}>
                  {copy("Dataset", "数据集")}
                </label>
                <ApSelect
                  label={copy("Evaluation dataset", "评测数据集")}
                  value={state.runDraft.datasetId}
                  disabled={busy || unknown || !canWrite}
                  onChange={(v) =>
                    choose("runDraft", { ...state.runDraft, datasetId: v })
                  }
                  options={state.datasets.map((d) => ({
                    value: d.datasetId,
                    label:
                      d.name +
                      " · " +
                      d.examples.length +
                      " " +
                      copy("examples", "样例"),
                  }))}
                />
              </div>
              <div>
                <label className={styles.fieldLabel}>
                  {copy("Provider", "提供商")}
                </label>
                <ApSelect
                  label={copy("Evaluation provider", "评测提供商")}
                  value={state.runDraft.providerId}
                  disabled={busy || unknown || !canWrite}
                  onChange={(v) =>
                    choose("runDraft", { ...state.runDraft, providerId: v })
                  }
                  options={state.providers.map((p) => ({
                    value: p.providerId,
                    label:
                      p.name +
                      (p.enabled ? "" : copy(" (Disabled)", "（未启用）")),
                  }))}
                />
              </div>
              <div>
                <label className={styles.fieldLabel}>
                  {copy("Grader", "评分器")}
                </label>
                <ApSelect
                  label={copy("Evaluation grader", "评测评分器")}
                  value={state.runDraft.grader}
                  disabled={busy || unknown || !canWrite}
                  onChange={(v) =>
                    choose("runDraft", {
                      ...state.runDraft,
                      grader: v as EvaluationGrader,
                    })
                  }
                  options={[
                    {
                      value: "contains",
                      label: copy("Contains expected phrase", "包含预期短语"),
                    },
                    { value: "exact", label: copy("Exact match", "精确匹配") },
                  ]}
                />
                <p className={styles.help}>
                  {copy(
                    "Both graders ignore letter case. Exact match also trims surrounding spaces.",
                    "两种评分器均不区分大小写，精确匹配还忽略首尾空白。",
                  )}
                </p>
              </div>
              {state.error && (
                <p role="alert" className={styles.error}>
                  {errorMessages[state.error]}
                </p>
              )}
              {unknown && (
                <>
                  <code>{state.operation!.operationId}</code>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => setState(checkEvaluation)}
                  >
                    {copy("Check operation", "查询操作")}
                  </Button>
                </>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (!unknown)
                      patch({
                        createOpen: false,
                        error: "",
                        runDraft: { ...state.runDraft, name: "" },
                      })
                    else choose("createOpen", false)
                  }}
                >
                  {copy("Cancel", "取消")}
                </Button>
                <Button
                  type="submit"
                  loading={busy}
                  disabled={!canWrite || unknown}
                >
                  <Play size={14} />
                  {copy("Run evaluation", "运行评测")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
        <Dialog
          open={active && state.datasetCreateOpen}
          onOpenChange={(open) => choose("datasetCreateOpen", open)}
        >
          <DialogContent
            className={styles.dialog}
            finalFocus={() => dialogFocus.current.datasetCreate}
          >
            <DialogTitle>{copy("Create dataset", "创建数据集")}</DialogTitle>
            <DialogDescription>
              {copy(
                "Changes are kept for this demo session.",
                "更改仅保存在本次样例会话。",
              )}
            </DialogDescription>
            <form
              className={styles.form}
              onSubmit={(e) => {
                e.preventDefault()
                if (!canWrite) return
                if (!state.datasetDraft.name.trim()) {
                  choose("error", "dataset-name")
                  return
                }
                const id = "ds_" + (state.sequence + 1)
                patch({
                  sequence: state.sequence + 1,
                  datasets: [
                    ...state.datasets,
                    {
                      datasetId: id,
                      version: 1,
                      name: state.datasetDraft.name.trim(),
                      description: state.datasetDraft.description,
                      examples: [],
                    },
                  ],
                  datasetCreateOpen: false,
                  datasetId: id,
                  datasetDraft: { name: "", description: "" },
                  notice: "dataset",
                  error: "",
                })
              }}
            >
              <Field
                label={copy("Name", "名称")}
                error={
                  state.error === "dataset-name"
                    ? errorMessages["dataset-name"]
                    : undefined
                }
              >
                {(props) => (
                  <Input
                    {...props}
                    autoFocus
                    value={state.datasetDraft.name}
                    onChange={(e) =>
                      choose("datasetDraft", {
                        ...state.datasetDraft,
                        name: e.target.value,
                      })
                    }
                  />
                )}
              </Field>
              <Field label={copy("Description", "描述")}>
                {(props) => (
                  <Textarea
                    {...props}
                    rows={2}
                    value={state.datasetDraft.description}
                    onChange={(e) =>
                      choose("datasetDraft", {
                        ...state.datasetDraft,
                        description: e.target.value,
                      })
                    }
                  />
                )}
              </Field>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    patch({
                      datasetCreateOpen: false,
                      datasetDraft: { name: "", description: "" },
                      error: "",
                    })
                  }
                >
                  {copy("Cancel", "取消")}
                </Button>
                <Button type="submit" disabled={!canWrite}>
                  {copy("Create dataset", "创建数据集")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
        <Sheet
          open={active && !!dataset}
          onOpenChange={(open) => {
            if (!open) choose("datasetId", null)
          }}
        >
          <SheetContent
            size={768}
            className={styles.sheet}
            finalFocus={() => dialogFocus.current.dataset}
          >
            <SheetHeader className={styles.sheetHeader}>
              <SheetTitle>{dataset?.name}</SheetTitle>
              <SheetDescription>{dataset?.description}</SheetDescription>
            </SheetHeader>
            <SheetBody className={styles.sheetBody}>
              {dataset && (
                <>
                  <div className={styles.datasetToolbar}>
                    <Badge className={styles.badge}>
                      {copy("Version", "版本")} {dataset.version} ·{" "}
                      {dataset.examples.length} {copy("examples", "样例")}
                    </Badge>
                    <div>
                      <Button
                        variant="outline"
                        disabled={!canWrite}
                        onClick={() =>
                          openModal("import", { importOpen: true, error: "" })
                        }
                      >
                        <Upload size={14} />
                        {copy("Import JSONL", "导入 JSONL")}
                      </Button>
                      <Button
                        disabled={!canWrite}
                        onClick={() => openExample(null)}
                      >
                        <Plus size={14} />
                        {copy("Add example", "添加样例")}
                      </Button>
                    </div>
                  </div>
                  <div className={styles.datasetExamples}>
                    {dataset.examples.map((example, index) => (
                      <article key={example.exampleId}>
                        <div className={styles.exampleTitle}>
                          <div>
                            <p className={styles.meta}>
                              {copy("EXAMPLE", "样例")} {index + 1}
                            </p>
                            <h3>{example.input}</h3>
                          </div>
                          <div>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={
                                copy("Edit example ", "编辑样例 ") + (index + 1)
                              }
                              disabled={!canWrite}
                              onClick={() => openExample(example.exampleId)}
                            >
                              <MoreHorizontal size={16} />
                            </Button>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={
                                copy("Delete example ", "删除样例 ") +
                                (index + 1)
                              }
                              disabled={!canWrite}
                              onClick={() =>
                                setState((s) =>
                                  replaceDatasetExamples(
                                    s,
                                    dataset.examples.filter(
                                      (e) => e.exampleId !== example.exampleId,
                                    ),
                                    canWrite,
                                  ),
                                )
                              }
                            >
                              <Trash2 size={16} />
                            </Button>
                          </div>
                        </div>
                        <div className={styles.outputColumns}>
                          <div>
                            <p className={styles.meta}>
                              {copy("Expected", "预期")}
                            </p>
                            <p>{example.expected}</p>
                          </div>
                          <div>
                            <p className={styles.meta}>
                              {copy("Candidate output", "候选输出")}
                            </p>
                            <p>
                              {example.candidate ?? copy("Missing", "缺失")}
                            </p>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                  {dataset.examples.length === 0 && (
                    <p className={styles.empty}>
                      {copy(
                        "This dataset is empty. Add an example or import JSONL before running an evaluation.",
                        "该数据集为空，请先添加样例或导入 JSONL。",
                      )}
                    </p>
                  )}
                  <div className={styles.datasetFooter}>
                    <Button
                      variant="outline"
                      onClick={() => {
                        download(
                          dataset.datasetId + "-v" + dataset.version + ".jsonl",
                          dataset.examples
                            .map((e) => JSON.stringify(e))
                            .join("\n"),
                          "application/x-ndjson",
                        )
                        choose("notice", "exported")
                      }}
                    >
                      <Download size={14} />
                      {copy("Export dataset", "导出数据集")}
                    </Button>
                    <Button
                      variant="ghost"
                      className={styles.delete}
                      disabled={!canWrite}
                      onClick={() =>
                        patch({
                          datasets: state.datasets.filter(
                            (d) => d.datasetId !== dataset.datasetId,
                          ),
                          datasetId: null,
                          notice: "deleted",
                        })
                      }
                    >
                      {copy("Delete dataset", "删除数据集")}
                    </Button>
                  </div>
                  <p className={styles.footnote}>
                    {copy(
                      "Edits create a new dataset version. Existing evaluation results keep their original snapshot.",
                      "编辑生成新版本，已有评测结果保留其原始快照。",
                    )}
                  </p>
                </>
              )}
            </SheetBody>
          </SheetContent>
        </Sheet>
        <Dialog
          open={active && state.exampleOpen}
          onOpenChange={(open) => choose("exampleOpen", open)}
        >
          <DialogContent
            className={styles.dialog}
            finalFocus={() => dialogFocus.current.example}
          >
            <DialogTitle>
              {state.editingExampleId
                ? copy("Edit example", "编辑样例")
                : copy("Add example", "添加样例")}
            </DialogTitle>
            <DialogDescription>
              {copy(
                "Changes are kept for this demo session.",
                "更改仅保存在本次样例会话。",
              )}
            </DialogDescription>
            <form
              className={styles.form}
              onSubmit={(e) => {
                e.preventDefault()
                setState((s) => saveExample(s, canWrite))
              }}
            >
              <Field label={copy("Input", "输入")}>
                {(props) => (
                  <Textarea
                    {...props}
                    autoFocus
                    rows={2}
                    value={state.exampleDraft.input}
                    onChange={(e) =>
                      choose("exampleDraft", {
                        ...state.exampleDraft,
                        input: e.target.value,
                      })
                    }
                  />
                )}
              </Field>
              <Field label={copy("Expected phrase or label", "预期短语或标签")}>
                {(props) => (
                  <Input
                    {...props}
                    value={state.exampleDraft.expected}
                    onChange={(e) =>
                      choose("exampleDraft", {
                        ...state.exampleDraft,
                        expected: e.target.value,
                      })
                    }
                  />
                )}
              </Field>
              <Field label={copy("Candidate output", "候选输出")}>
                {(props) => (
                  <Textarea
                    {...props}
                    rows={2}
                    value={state.exampleDraft.candidate ?? ""}
                    onChange={(e) =>
                      choose("exampleDraft", {
                        ...state.exampleDraft,
                        candidate: e.target.value,
                      })
                    }
                  />
                )}
              </Field>
              {state.error && (
                <p role="alert" className={styles.error}>
                  {errorMessages[state.error]}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    patch({
                      exampleOpen: false,
                      exampleDraft: {
                        exampleId: "",
                        input: "",
                        expected: "",
                        candidate: "",
                      },
                      editingExampleId: null,
                      error: "",
                    })
                  }
                >
                  {copy("Cancel", "取消")}
                </Button>
                <Button type="submit" disabled={!canWrite}>
                  {copy("Save changes", "保存更改")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
        <Dialog
          open={active && state.importOpen}
          onOpenChange={(open) => choose("importOpen", open)}
        >
          <DialogContent
            className={styles.dialog}
            finalFocus={() => dialogFocus.current.import}
          >
            <DialogTitle>{copy("Import JSONL", "导入 JSONL")}</DialogTitle>
            <DialogDescription>
              {copy(
                "Append examples to a new dataset version. Each line contains input, expected and candidate.",
                "追加样例并生成新数据集版本，每行包含 input、expected 和 candidate。",
              )}
            </DialogDescription>
            <form
              className={styles.form}
              onSubmit={(e) => {
                e.preventDefault()
                setState((s) => importExamples(s, canWrite))
              }}
            >
              <Field label="JSONL">
                {(props) => (
                  <Textarea
                    {...props}
                    autoFocus
                    rows={8}
                    value={state.importDraft}
                    onChange={(e) => choose("importDraft", e.target.value)}
                  />
                )}
              </Field>
              {state.error && (
                <p role="alert" className={styles.error}>
                  {errorMessages[state.error]}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => patch({ importOpen: false, error: "" })}
                >
                  {copy("Cancel", "取消")}
                </Button>
                <Button type="submit" disabled={!canWrite}>
                  {copy("Import examples", "导入样例")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
        <Dialog
          open={active && state.providerOpen}
          onOpenChange={(open) => choose("providerOpen", open)}
        >
          <DialogContent
            className={styles.dialog}
            finalFocus={() => dialogFocus.current.provider}
          >
            <DialogTitle>
              {copy("Configure", "配置")} {state.providerDraft?.name}
            </DialogTitle>
            <DialogDescription>
              {copy(
                "Configure a demo provider. No credentials or external connection are required.",
                "配置样例提供商，无需凭据或外部连接。",
              )}
            </DialogDescription>
            {state.providerDraft && (
              <form
                className={styles.form}
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!canWrite) return
                  const draft = state.providerDraft!
                  const model = apModels.find(
                    (m) =>
                      m.modelId === draft.modelId &&
                      m.providerId === draft.providerId &&
                      m.modality === "text" &&
                      m.status === "available",
                  )
                  let valid = false
                  try {
                    valid = new URL(draft.endpoint).protocol === "https:"
                  } catch {}
                  if (!valid || (draft.enabled && !model)) {
                    choose("error", "provider-invalid")
                    return
                  }
                  patch({
                    providers: state.providers.map((p) =>
                      p.providerId === draft.providerId
                        ? {
                            ...draft,
                            version: p.version + 1,
                            modelLabel: model?.name ?? draft.modelLabel,
                          }
                        : p,
                    ),
                    providerDraft: null,
                    providerOpen: false,
                    notice: "configured",
                    error: "",
                  })
                }}
              >
                <Field label={copy("Endpoint URL", "端点 URL")}>
                  {(props) => (
                    <Input
                      {...props}
                      autoFocus
                      value={state.providerDraft!.endpoint}
                      onChange={(e) =>
                        choose("providerDraft", {
                          ...state.providerDraft!,
                          endpoint: e.target.value,
                        })
                      }
                    />
                  )}
                </Field>
                <div>
                  <label className={styles.fieldLabel}>
                    {copy("Model label", "模型标签")}
                  </label>
                  <ApSelect
                    label={copy("Provider model", "提供商模型")}
                    value={state.providerDraft.modelId ?? "unavailable"}
                    onChange={(v) =>
                      choose("providerDraft", {
                        ...state.providerDraft!,
                        modelId: v,
                      })
                    }
                    options={
                      state.providerDraft.providerId === "custom"
                        ? [
                            {
                              value: "unavailable",
                              label: copy(
                                "No catalog model available",
                                "没有可用目录模型",
                              ),
                            },
                          ]
                        : apModels
                            .filter(
                              (m) =>
                                m.providerId ===
                                  state.providerDraft!.providerId &&
                                m.modality === "text",
                            )
                            .map((m) => ({ value: m.modelId, label: m.name }))
                    }
                  />
                </div>
                <div className={styles.switchField}>
                  <label htmlFor="evaluation-provider-enabled">
                    {copy("Available for evaluations", "可用于评测")}
                  </label>
                  <Switch
                    id="evaluation-provider-enabled"
                    checked={state.providerDraft.enabled}
                    onCheckedChange={(enabled) =>
                      choose("providerDraft", {
                        ...state.providerDraft!,
                        enabled,
                      })
                    }
                  />
                </div>
                {state.error && (
                  <p role="alert" className={styles.error}>
                    {errorMessages[state.error]}
                  </p>
                )}
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      patch({
                        providerDraft: null,
                        providerOpen: false,
                        error: "",
                      })
                    }
                  >
                    {copy("Cancel", "取消")}
                  </Button>
                  <Button type="submit" disabled={!canWrite}>
                    {copy("Save changes", "保存更改")}
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </ApPage>
    </div>
  )
}
