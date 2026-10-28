"use client"

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from "react"
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  Download,
  Monitor,
  PanelRight,
  PanelRightClose,
  Play,
  Plus,
  RotateCcw,
  Square,
  X,
} from "lucide-react"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@easyuse-ui/ui/components/ui/input-group"
import { FormSection } from "@easyuse-ui/ui/components/blocks/form-section"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@easyuse-ui/ui/components/ui/select"
import { ResizableHandle } from "@easyuse-ui/ui/components/ui/resizable"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import { RuntimeStatusBadge } from "@easyuse-ui/ui/components/ui/runtime-status-badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@easyuse-ui/ui/components/ui/dialog"
import {
  RemainingPageStateProvider,
  useRemainingPageState,
} from "../../showcase/state"
import {
  remainingPageScenarios,
  type RemainingPageProps,
} from "../../showcase/model"
import {
  createResearchState,
  exportBrief,
  researchTransition,
  type ResearchAction,
} from "./controller"
import { regions, sourceTypes, text, windows } from "./fixtures"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios
export function RemainingPageView(props: RemainingPageProps) {
  return (
    <RemainingPageStateProvider cache={props.cache}>
      <ResearchBrief key={props.scenario} {...props} />
    </RemainingPageStateProvider>
  )
}
function ResearchBrief({ scenario, active, host, cache }: RemainingPageProps) {
  const { locale } = useI18n()
  const l = (zh: string, en: string) => (locale === "en" ? en : zh)
  const [state, setState] = useRemainingPageState(
    "research-brief-builder:" + scenario,
    () => createResearchState(scenario),
  )
  const [resetOpen, setResetOpen] = useState(false)
  const [frameWidth, setFrameWidth] = useState(1451)
  const frame = useRef<HTMLDivElement>(null)
  const briefScroll = useRef<HTMLDivElement>(null)
  const planScroll = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const initialScroll = useRef({
    brief: state.briefScroll,
    plan: state.planScroll,
  })
  const id = useId()
  const selectionKey = "research-brief-builder:" + scenario + ":selection"
  const locked =
    !state.canEdit ||
    state.data === "loading" ||
    state.run?.status === "running"
  const dispatch = (action: ResearchAction) =>
    setState((s) => researchTransition(s, action))
  const error = (key: string) =>
    state.errors[key]
      ? l("请填写此项。", "Please complete this field.")
      : undefined
  useEffect(() => {
    const node = frame.current
    if (!node) return
    const observer = new ResizeObserver((entries) =>
      setFrameWidth(entries[0].contentRect.width),
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (briefScroll.current)
      briefScroll.current.scrollTop = initialScroll.current.brief
    if (planScroll.current)
      planScroll.current.scrollTop = initialScroll.current.plan
  }, [])
  useLayoutEffect(() => {
    if (state.planOpen && planScroll.current)
      planScroll.current.scrollTop = state.planScroll
  }, [state.planOpen, state.planScroll])
  useLayoutEffect(() => {
    if (!active) return
    const saved = cache.get(selectionKey) as
      { id: string; start: number; end: number } | undefined
    if (saved) {
      const input = frame.current?.querySelector<
        HTMLInputElement | HTMLTextAreaElement
      >('[data-draft-id="' + saved.id + '"]')
      input?.setSelectionRange(saved.start, saved.end)
    }
  }, [active, cache, selectionKey])
  const rememberSelection = (
    event: SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const input = event.currentTarget
    cache.set(selectionKey, {
      id: input.dataset.draftId,
      start: input.selectionStart,
      end: input.selectionEnd,
    })
  }
  const focusDraft = (draftId: string) =>
    requestAnimationFrame(() =>
      frame.current
        ?.querySelector<HTMLElement>('[data-draft-id="' + draftId + '"]')
        ?.focus(),
    )
  const closePlan = () => {
    setState((s) => ({ ...s, planOpen: false }))
    requestAnimationFrame(() => opener.current?.focus())
  }
  const add = (kind: "questions" | "steps") => {
    const next = (kind === "questions" ? "question-" : "step-") + state.nextId
    dispatch({ type: "row-add", kind })
    focusDraft(next)
  }
  const remove = (kind: "questions" | "steps", rowId: string) => {
    const rows = state.brief[kind],
      index = rows.findIndex((r) => r.id === rowId),
      next = rows[index + 1] ?? rows[index - 1]
    dispatch({ type: "row-remove", kind, id: rowId })
    if (next) focusDraft(next.id)
    else
      requestAnimationFrame(() =>
        frame.current
          ?.querySelector<HTMLElement>('[data-add="' + kind + '"]')
          ?.focus(),
      )
  }
  const review = (type: "review" | "start") => {
    dispatch({ type })
    requestAnimationFrame(() => {
      const invalid = frame.current?.querySelector<HTMLElement>(
        '[aria-invalid="true"], [data-invalid-group="true"]',
      )
      if (invalid) invalid.focus()
      else if (type === "review")
        planScroll.current?.focus({ preventScroll: true })
    })
  }
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([exportBrief(state, locale)], {
        type: "text/markdown;charset=utf-8",
      }),
    )
    const link = document.createElement("a")
    link.href = url
    link.download = "research-brief.md"
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const questionRows = state.brief.questions
  const renderRows = (kind: "questions" | "steps") => {
    const rows = state.brief[kind]
    return (
      <div
        className={styles.rows}
        role="group"
        aria-label={
          kind === "questions"
            ? l("研究问题", "Research questions")
            : l("计划步骤", "Plan steps")
        }
        data-invalid-group={!!state.errors[kind]}
        aria-describedby={state.errors[kind] ? id + kind + "-error" : undefined}
        tabIndex={state.errors[kind] ? -1 : undefined}
      >
        {rows.map((row, index) => (
          <div key={row.id} className={styles.row}>
            <label className="sr-only" htmlFor={id + row.id}>
              {kind === "questions"
                ? l("问题 ", "Question ")
                : l("步骤 ", "Step ")}
              {index + 1}
            </label>
            <InputGroup className={styles.editRow}>
              <InputGroupTextarea
                id={id + row.id}
                data-draft-id={row.id}
                rows={2}
                maxLength={500}
                value={text(row.value, locale)}
                disabled={locked}
                aria-invalid={!!state.errors[row.id]}
                aria-describedby={
                  state.errors[row.id] ? id + row.id + "-error" : undefined
                }
                onSelect={rememberSelection}
                onChange={(e) =>
                  dispatch({
                    type: "row-edit",
                    kind,
                    id: row.id,
                    value: e.target.value,
                  })
                }
              />
              <InputGroupAddon className={styles.rowActions}>
                <span>
                  {kind === "questions"
                    ? l("问题 ", "Question ")
                    : l("步骤 ", "Step ")}
                  {index + 1}
                </span>
                {kind === "steps" && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={locked || index === 0}
                      aria-label={
                        l("上移步骤 ", "Move step ") +
                        (index + 1) +
                        l("", " up")
                      }
                      onClick={() =>
                        dispatch({ type: "move", id: row.id, direction: -1 })
                      }
                    >
                      <ArrowUp size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={locked || index === rows.length - 1}
                      aria-label={
                        l("下移步骤 ", "Move step ") +
                        (index + 1) +
                        l("", " down")
                      }
                      onClick={() =>
                        dispatch({ type: "move", id: row.id, direction: 1 })
                      }
                    >
                      <ArrowDown size={14} />
                    </Button>
                  </>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={locked}
                  aria-label={
                    (kind === "questions"
                      ? l("删除问题 ", "Remove question ")
                      : l("删除步骤 ", "Remove step ")) +
                    (index + 1)
                  }
                  onClick={() => remove(kind, row.id)}
                >
                  <X size={14} />
                </Button>
              </InputGroupAddon>
            </InputGroup>
            {state.errors[row.id] && (
              <p className={styles.error} id={id + row.id + "-error"}>
                {error(row.id)}
              </p>
            )}
          </div>
        ))}
        {!rows.length && (
          <p className={styles.empty}>
            {kind === "questions"
              ? l(
                  "添加一个问题，为研究确定方向。",
                  "Add a question to give the research direction.",
                )
              : l(
                  "添加一个步骤，规划研究顺序。",
                  "Add a step to plan the research sequence.",
                )}
          </p>
        )}
        {state.errors[kind] && (
          <p id={id + kind + "-error"} className={styles.error} role="alert">
            {kind === "questions"
              ? l(
                  "至少添加一个研究问题。",
                  "Add at least one research question.",
                )
              : l("至少添加一个计划步骤。", "Add at least one plan step.")}
          </p>
        )}
        <Button
          variant="ghost"
          className={styles.add}
          data-add={kind}
          disabled={locked || rows.length >= 20}
          onClick={() => add(kind)}
        >
          <Plus size={14} />
          {kind === "questions"
            ? l("添加问题", "Add question")
            : l("添加步骤", "Add step")}
        </Button>
        {rows.length >= 20 && (
          <p className={styles.muted}>
            {l("最多 20 项。", "Maximum 20 items.")}
          </p>
        )}
      </div>
    )
  }
  const regionItems = regions.map((o) => ({
    value: o.id,
    label: text(o.label, locale),
  }))
  const windowItems = windows.map((o) => ({
    value: o.id,
    label: text(o.label, locale),
  }))
  return (
    <div className={styles.page} data-research-brief-builder ref={frame}>
      <header className={styles.header}>
        <span>{l("研究简报", "Research brief")}</span>
        <div className={styles.headerActions}>
          <Button
            ref={opener}
            variant="ghost"
            onClick={() =>
              state.planOpen
                ? closePlan()
                : setState((s) => ({ ...s, planOpen: true }))
            }
          >
            <PanelRight size={14} />
            {state.planOpen
              ? l("隐藏计划", "Hide plan")
              : l("打开计划", "Open plan")}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={locked}
            aria-label={l("重置研究简报演示", "Reset research brief demo")}
            onClick={() => setResetOpen(true)}
          >
            <RotateCcw size={14} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={l("切换主题", "Toggle theme")}
            onClick={() =>
              host.setTheme(host.resolvedTheme === "dark" ? "light" : "dark")
            }
          >
            <Monitor size={16} />
          </Button>
        </div>
      </header>
      <div className={styles.workspace}>
        <section
          className={styles.briefPane}
          aria-label={l("你的简报", "Your brief")}
          style={
            state.planOpen ? { width: frameWidth * state.split } : { flex: 1 }
          }
        >
          <div className={styles.paneHeader}>
            <h2>{l("你的简报", "Your brief")}</h2>
            <span className={styles.badge}>{l("草稿", "Draft")}</span>
          </div>
          <div
            className={styles.scroll}
            ref={briefScroll}
            data-scroll="brief"
            onScroll={(e) => {
              const value = e.currentTarget.scrollTop
              setState((s) => ({ ...s, briefScroll: value }))
            }}
          >
            <div className={styles.formContent}>
              <div className={styles.intro}>
                <p className={styles.eyebrow}>
                  {l("研究 / 新简报", "RESEARCH / NEW BRIEF")}
                </p>
                <h1>
                  {l("从正确的问题开始。", "Start with the right question.")}
                </h1>
                <p>
                  {l(
                    "明确决策、设定边界，在研究开始前规划工作。",
                    "Define the decision, set the boundaries, and shape the work before research begins.",
                  )}
                </p>
              </div>
              {state.data === "loading" && (
                <Button
                  variant="secondary"
                  onClick={() => dispatch({ type: "recover" })}
                >
                  {l("加载本地简报", "Load local brief")}
                </Button>
              )}
              <DataRegion
                state={state.data === "ready" ? "success" : state.data}
                hasContent={state.data !== "loading"}
                rowHeight={100}
                loadingLabel={l("正在加载研究简报", "Loading research brief")}
                error={{
                  category: "network",
                  message: l("演示刷新失败。", "Demo refresh failed."),
                  reason: l(
                    "已有草稿保留；重读只恢复本地 fixture。",
                    "Draft retained; retry reloads only the local fixture.",
                  ),
                }}
                onRetry={() => dispatch({ type: "recover" })}
              >
                {!state.canEdit && (
                  <p className={styles.notice}>
                    {l(
                      "只读简报：可以浏览和查看计划，不能编辑或开始演示。",
                      "Read-only brief: browse and review the plan; editing and demo runs are unavailable.",
                    )}
                  </p>
                )}
                <form
                  className={styles.form}
                  onSubmit={(e) => {
                    e.preventDefault()
                    review("review")
                  }}
                  noValidate
                >
                  <Field
                    id={id + "goal"}
                    label={l("你想了解什么？", "What do you want to learn?")}
                    error={error("goal")}
                    className={styles.field}
                  >
                    {(p) => (
                      <Textarea
                        {...p}
                        data-draft-id="goal"
                        className={styles.goal}
                        rows={3}
                        maxLength={1000}
                        value={text(state.brief.goal, locale)}
                        disabled={locked}
                        onSelect={rememberSelection}
                        onChange={(e) =>
                          dispatch({
                            type: "field",
                            field: "goal",
                            value: e.target.value,
                          })
                        }
                      />
                    )}
                  </Field>
                  <Field
                    id={id + "audience"}
                    label={l("面向谁？", "Who is this for?")}
                    error={error("audience")}
                    className={styles.field}
                  >
                    {(p) => (
                      <Input
                        {...p}
                        data-draft-id="audience"
                        className={styles.audience}
                        maxLength={200}
                        value={text(state.brief.audience, locale)}
                        disabled={locked}
                        onSelect={rememberSelection}
                        onChange={(e) =>
                          dispatch({
                            type: "field",
                            field: "audience",
                            value: e.target.value,
                          })
                        }
                      />
                    )}
                  </Field>
                  <FormSection
                    title={l("研究问题", "Research questions")}
                    className={styles.section}
                  >
                    {renderRows("questions")}
                  </FormSection>
                  <FormSection
                    title={l("范围与来源", "Scope & sources")}
                    className={styles.section}
                  >
                    <div className={styles.scopeGrid}>
                      {(
                        [
                          ["region", l("区域", "Region"), regionItems],
                          [
                            "window",
                            l("发表时间范围", "Publication window"),
                            windowItems,
                          ],
                        ] as const
                      ).map(([field, label, items]) => (
                        <Field
                          key={field}
                          label={label}
                          id={id + field}
                          className={styles.field}
                        >
                          {(p) => (
                            <Select
                              items={items}
                              value={state.brief[field]}
                              disabled={locked}
                              onValueChange={(value) => {
                                if (value)
                                  dispatch({ type: "scope", field, value })
                              }}
                            >
                              <SelectTrigger {...p} className={styles.select}>
                                <SelectValue />
                                <ChevronDown size={14} />
                              </SelectTrigger>
                              <SelectContent>
                                {items.map((o) => (
                                  <SelectItem key={o.value} value={o.value}>
                                    {o.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </Field>
                      ))}
                    </div>
                    <fieldset className={styles.sources}>
                      <legend>
                        {l("允许的来源类型", "Allowed source types")}
                      </legend>
                      {sourceTypes.map((source) => (
                        <label key={source.id}>
                          <Checkbox
                            checked={state.brief.sources.includes(source.id)}
                            disabled={locked}
                            onCheckedChange={(checked) =>
                              dispatch({
                                type: "source",
                                id: source.id,
                                checked,
                              })
                            }
                            aria-invalid={!!state.errors.sources}
                            aria-describedby={
                              state.errors.sources
                                ? id + "sources-error"
                                : undefined
                            }
                          />
                          {text(source.label, locale)}
                        </label>
                      ))}
                      {state.errors.sources && (
                        <p
                          id={id + "sources-error"}
                          className={styles.error}
                          role="alert"
                        >
                          {l(
                            "至少选择一种来源类型。",
                            "Select at least one source type.",
                          )}
                        </p>
                      )}
                    </fieldset>
                    <Field
                      id={id + "exclusions"}
                      label={
                        <>
                          {l("排除内容", "Leave out")}{" "}
                          <span className={styles.muted}>
                            {l("（可选）", "(optional)")}
                          </span>
                        </>
                      }
                      className={styles.field}
                    >
                      {(p) => (
                        <Textarea
                          {...p}
                          data-draft-id="exclusions"
                          className={styles.exclusions}
                          rows={2}
                          maxLength={1000}
                          disabled={locked}
                          value={text(state.brief.exclusions, locale)}
                          onSelect={rememberSelection}
                          onChange={(e) =>
                            dispatch({
                              type: "field",
                              field: "exclusions",
                              value: e.target.value,
                            })
                          }
                        />
                      )}
                    </Field>
                  </FormSection>
                  <div className={styles.review}>
                    <Button
                      type="submit"
                      variant="secondary"
                      disabled={state.data === "loading"}
                    >
                      {l("查看计划", "Review plan")}
                      <ArrowRight size={14} />
                    </Button>
                  </div>
                </form>
              </DataRegion>
            </div>
          </div>
        </section>
        {state.planOpen && (
          <>
            <ResizableHandle
              value={frameWidth * state.split}
              min={Math.min(460, frameWidth * 0.45)}
              max={Math.max(460, frameWidth - 360)}
              onValueChange={(value) =>
                setState((s) => ({ ...s, split: value / frameWidth }))
              }
              label={l("调整研究计划宽度", "Resize research plan")}
              controls={id + "plan"}
              className={styles.handle}
            />
            <aside
              className={styles.planPane}
              id={id + "plan"}
              aria-label={l("研究计划", "Research plan")}
            >
              <div className={styles.paneHeader}>
                <div className={styles.titleGroup}>
                  <h2>{l("研究计划", "Research plan")}</h2>
                  <span className={styles.badge}>
                    {state.brief.steps.length}
                    {l(" 个步骤", " steps")}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={l("关闭研究计划", "Close research plan")}
                  onClick={closePlan}
                >
                  <PanelRightClose size={14} />
                </Button>
              </div>
              <div
                className={styles.scroll}
                ref={planScroll}
                data-scroll="plan"
                tabIndex={-1}
                onScroll={(e) => {
                  const value = e.currentTarget.scrollTop
                  setState((s) => ({ ...s, planScroll: value }))
                }}
              >
                <div className={styles.planContent}>
                  {!state.run ? (
                    <>
                      <div className={styles.planIntro}>
                        <h3>
                          {l("你可以调整的计划。", "A plan you can shape.")}
                        </h3>
                        <p>
                          {l(
                            "开始前编辑步骤顺序，让工作始终围绕简报中的问题展开。",
                            "Edit the sequence before starting. Keep the work focused on the questions in your brief.",
                          )}
                        </p>
                      </div>
                      <fieldset className={styles.steps}>
                        <legend className="sr-only">
                          {l("计划步骤", "Plan steps")}
                        </legend>
                        {renderRows("steps")}
                      </fieldset>
                      <dl className={styles.summary}>
                        <dt>{l("覆盖范围", "Coverage")}</dt>
                        <dd>
                          {questionRows.length}
                          {l(" 个研究问题", " research questions")}
                        </dd>
                        <dt>{l("来源", "Sources")}</dt>
                        <dd>
                          {sourceTypes
                            .filter((s) => state.brief.sources.includes(s.id))
                            .map((s) => text(s.label, locale))
                            .join(" · ") ||
                            l("未选择来源", "No sources selected")}
                        </dd>
                        <dt>{l("交付物", "Deliverable")}</dt>
                        <dd>
                          {l(
                            "包含证据与未解问题的决策简报",
                            "Decision brief with evidence and open questions",
                          )}
                        </dd>
                      </dl>
                      {state.reviewed && (
                        <p className={styles.notice} role="status">
                          <Check size={14} />
                          {l(
                            "计划已检查，可以开始本地演示。",
                            "Plan reviewed. Ready for a local demonstration.",
                          )}
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <div className={styles.planIntro}>
                        <h3>
                          {l("本地研究演示", "Local research demonstration")}
                        </h3>
                        <p>
                          {l(
                            "按步骤演练计划，不调用外部服务或生成真实研究结论。",
                            "Walk through the plan without external services or real research conclusions.",
                          )}
                        </p>
                        <RuntimeStatusBadge status={state.run.status} />
                      </div>
                      <ol className={styles.runSteps}>
                        {state.run.snapshot.steps.map((step, index) => (
                          <li
                            key={step.id}
                            aria-current={
                              index === state.run!.completed
                                ? "step"
                                : undefined
                            }
                          >
                            <RuntimeStatusBadge
                              status={
                                index < state.run!.completed
                                  ? "completed"
                                  : index === state.run!.completed &&
                                      state.run!.status === "running"
                                    ? "running"
                                    : "idle"
                              }
                            />
                            <span>{text(step.value, locale)}</span>
                          </li>
                        ))}
                      </ol>
                      <p role="status" className={styles.muted}>
                        {state.run.completed} /{" "}
                        {state.run.snapshot.steps.length}
                        {l(" 个本地步骤已演练", " local steps reviewed")}
                      </p>
                      {state.run.status !== "running" && (
                        <article className={styles.artifact}>
                          <h3>
                            {l(
                              "决策简报 · 本地草稿",
                              "Decision brief · Local draft",
                            )}
                          </h3>
                          <p>{text(state.run.snapshot.goal, locale)}</p>
                          <h4>{l("需要回答的问题", "Questions to answer")}</h4>
                          <ul>
                            {state.run.snapshot.questions.map((q) => (
                              <li key={q.id}>{text(q.value, locale)}</li>
                            ))}
                          </ul>
                          <p className={styles.notice}>
                            {l(
                              "尚未获取外部证据。所有问题仍待验证；这份文档记录你的研究计划，而非研究发现。",
                              "No external evidence retrieved. All questions remain open; this document records your research plan, not research findings.",
                            )}
                          </p>
                          <Button variant="secondary" onClick={download}>
                            <Download size={14} />
                            {l("导出本地简报", "Export local brief")}
                          </Button>
                        </article>
                      )}
                    </>
                  )}
                </div>
              </div>
              <footer className={styles.footer}>
                {!state.run ? (
                  <Button
                    className={styles.start}
                    disabled={locked}
                    onClick={() => review("start")}
                  >
                    <Play size={14} />
                    {l("开始演示运行", "Start demo run")}
                  </Button>
                ) : state.run.status === "running" ? (
                  <div className={styles.runActions}>
                    <Button
                      disabled={!state.canEdit}
                      onClick={() => dispatch({ type: "advance" })}
                    >
                      <ArrowRight size={14} />
                      {l("推进演示步骤", "Advance demo step")}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => dispatch({ type: "stop" })}
                    >
                      <Square size={14} />
                      {l("停止", "Stop")}
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => dispatch({ type: "back" })}
                  >
                    {l("返回编辑计划", "Back to plan")}
                  </Button>
                )}
                <p>
                  {l(
                    "仅本地运行 · 无外部服务",
                    "Runs locally · No external services",
                  )}
                </p>
              </footer>
            </aside>
          </>
        )}
      </div>
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogTitle>
            {l("重置研究简报？", "Reset research brief?")}
          </DialogTitle>
          <DialogDescription>
            {l(
              "仅清除当前场景的内存草稿与演示记录，恢复此场景的初始内容。",
              "Clear this scenario’s in-memory draft and demonstration record, restoring its initial content.",
            )}
          </DialogDescription>
          <div className={styles.dialogActions}>
            <Button variant="secondary" onClick={() => setResetOpen(false)}>
              {l("取消", "Cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={locked}
              onClick={() => {
                setState(createResearchState(scenario))
                cache.delete(selectionKey)
                setResetOpen(false)
                if (briefScroll.current) briefScroll.current.scrollTop = 0
                focusDraft("goal")
              }}
            >
              {l("重置草稿", "Reset draft")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
