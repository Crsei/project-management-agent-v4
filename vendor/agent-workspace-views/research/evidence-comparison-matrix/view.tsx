"use client"

import { useLayoutEffect, useRef } from "react"
import { Check, CircleHelp, Download, Minus, Monitor, TriangleAlert } from "lucide-react"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import { Table, TableBody, TableCaption, TableCell, TableContainer, TableHead, TableHeader, TableRow } from "@easyuse-ui/ui/components/ui/table"
import { RemainingPageStateProvider, useRemainingPageState } from "../../showcase/state"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { assessments, filters, relations, sources, text, type Relation } from "./fixtures"
import { createMatrixState, exportMatrixCsv, matrixTransition, visibleClaims, type MatrixAction, type MatrixState } from "./controller"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios
export function RemainingPageView(props: RemainingPageProps) {
  return <RemainingPageStateProvider cache={props.cache}><EvidenceMatrix key={props.scenario} {...props} /></RemainingPageStateProvider>
}

const relationIcons = { supports: Check, conflicts: TriangleAlert, qualifies: CircleHelp, none: Minus }

function EvidenceMatrix({ scenario, active, host, cache }: RemainingPageProps) {
  const { locale } = useI18n()
  const l = (zh: string, en: string) => locale === "en" ? en : zh
  const stateKey = "evidence-comparison-matrix:" + scenario
  const [state, setState] = useRemainingPageState(stateKey, () => createMatrixState(scenario))
  const root = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const tableScroll = useRef<HTMLDivElement>(null)
  const initialScroll = useRef(state.scroll)
  const visible = visibleClaims(state)
  const selected = visible.find(claim => claim.id === state.selectedClaim)
  const reviewedCount = state.claims.reduce((total, claim) => total + sources.filter(source => state.reviewed[claim.id + ":" + source.id]).length, 0)
  const focusKey = stateKey + ":focus"
  const dispatch = (action: MatrixAction) => setState(previous => matrixTransition(previous, action))

  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = initialScroll.current.page
    if (tableScroll.current) {
      tableScroll.current.scrollTop = initialScroll.current.tableTop
      tableScroll.current.scrollLeft = initialScroll.current.tableLeft
    }
  }, [])
  useLayoutEffect(() => {
    if (!active) return
    const savedScroll = (cache.get(stateKey) as MatrixState | undefined)?.scroll ?? initialScroll.current
    if (scroll.current) scroll.current.scrollTop = savedScroll.page
    if (tableScroll.current) {
      tableScroll.current.scrollTop = savedScroll.tableTop
      tableScroll.current.scrollLeft = savedScroll.tableLeft
    }
    const focusId = cache.get(focusKey) as string | undefined
    const element = focusId ? [...(root.current?.querySelectorAll<HTMLElement>("[data-focus-id]") ?? [])].find(node => node.dataset.focusId === focusId) : undefined
    element?.focus({ preventScroll: true })
  }, [active, cache, focusKey, stateKey])

  const relationLabel = (relation: Relation) => {
    const Icon = relationIcons[relation]
    return <span className={styles.relation} data-relation={relation}><Icon size={14} aria-hidden="true" strokeWidth={1.75} />{text(relations[relation], locale)}</span>
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([exportMatrixCsv(state, locale)], { type: "text/csv;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = "onboarding-evidence-matrix.csv"
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <div className={styles.page} data-evidence-comparison-matrix ref={root} onFocusCapture={event => {
    const element = (event.target as HTMLElement).closest<HTMLElement>("[data-focus-id]")
    if (element?.dataset.focusId) cache.set(focusKey, element.dataset.focusId)
  }}>
    <header className={styles.header}>
      <span>{l("证据对比", "Evidence comparison")}</span>
      <div className={styles.headerActions}>
        <Badge size="sm">{l("演示证据", "Demo evidence")}</Badge>
        <Button variant="secondary" size="sm" data-focus-id="export" disabled={!state.claims.length || state.data === "loading"} onClick={download}><Download size={14} aria-hidden="true" />{l("导出矩阵", "Export matrix")}</Button>
        <Button variant="ghost" size="icon" data-focus-id="theme" aria-label={l("切换主题", "Toggle theme")} onClick={() => host.setTheme(host.resolvedTheme === "dark" ? "light" : "dark")}><Monitor size={16} aria-hidden="true" /></Button>
      </div>
    </header>
    <div className={styles.content} data-scroll="page" ref={scroll} onScroll={event => { if (active) dispatch({ type: "scroll", area: "page", value: event.currentTarget.scrollTop }) }}>
      <div className={styles.intro}>
        <p className={styles.eyebrow}>{l("入门研究 / 证据审阅", "Onboarding study / Evidence review")}</p>
        <h1>{l("来源在哪些方面达成一致？", "Where do the sources agree?")}</h1>
        <p className={styles.description}>{l("浏览整体模式。选择一项主张，将相关来源放在一起阅读。", "Scan the pattern. Select a claim to read the sources together.")}</p>
      </div>
      {!state.canReview && <p className={styles.notice} id="matrix-readonly">{l("只读：可以筛选、查看和导出，但不能更改审阅标记。", "Read only: filter, inspect, and export; review flags cannot be changed.")}</p>}
      <div className={styles.toolbar}>
        <div className={styles.filters} role="group" aria-label={l("筛选主张", "Filter claims")}>
          {filters.map(filter => <Button key={filter} variant="ghost" data-focus-id={"filter-" + filter} aria-pressed={state.filter === filter} disabled={state.data === "loading"} onClick={() => {
            dispatch({ type: "filter", filter })
            if (tableScroll.current) tableScroll.current.scrollTop = 0
          }}>{filter === "all" ? l("全部主张", "All claims") : text(assessments[filter], locale)}</Button>)}
        </div>
        <p className={styles.progress} role="status">{locale === "en" ? `${reviewedCount} of ${state.claims.length * sources.length} cells reviewed` : `已审阅 ${reviewedCount} / ${state.claims.length * sources.length} 个单元格`}</p>
      </div>
      <DataRegion state={state.data} hasContent={state.data === "error" && !!state.claims.length} rowHeight={112} loadingLabel={l("正在加载证据矩阵", "Loading evidence matrix")} emptyTitle={l("暂无研究证据", "No research evidence yet")} emptyDescription={l("加载本地入门研究样本，开始对比主张与来源。", "Load the local onboarding study sample to compare claims and sources.")} emptyAction={<Button variant="secondary" data-focus-id="load-empty" onClick={() => dispatch({ type: "load-fixture" })}>{l("加载演示证据", "Load demo evidence")}</Button>} error={{ category: "request", message: l("演示刷新未能完成。", "The demo refresh did not complete."), reason: l("现有证据和审阅标记已保留。重试仅重新加载本地样本。", "Evidence and review flags were preserved. Retry reloads only the local sample.") }} onRetry={() => dispatch({ type: "load-fixture" })}>
        <TableContainer ref={tableScroll} className={styles.matrixScroll} data-scroll="matrix" data-focus-id="matrix-scroll" aria-label={l("证据矩阵滚动区域", "Evidence matrix scroll area")} onScroll={event => {
          if (!active) return
          const node = event.currentTarget
          setState(previous => ({ ...previous, scroll: { ...previous.scroll, tableTop: node.scrollTop, tableLeft: node.scrollLeft } }))
        }}>
          <Table className={styles.matrix}>
            <TableCaption className="sr-only">{l("入门研究主张及三个演示来源提供的支持或冲突证据", "Onboarding claims and supporting or conflicting evidence from three demo sources")}</TableCaption>
            <TableHeader className={styles.tableHeader}><TableRow>
              <TableHead className={styles.claimHead}>{l("主张 / 评估", "Claim / assessment")}</TableHead>
              {sources.map(source => <TableHead key={source.id} className={styles.sourceHead}><span className={styles.provenance}>{text(source.provenance, locale)}</span>{text(source.title, locale)}</TableHead>)}
            </TableRow></TableHeader>
            <TableBody>
              {visible.map(claim => <TableRow key={claim.id}>
                <TableHead scope="row" className={styles.claimCell} data-selected={claim.id === selected?.id}><span className={styles.claimTitle}>{text(claim.title, locale)}</span><Badge className={styles.assessment} size="sm">{text(assessments[claim.assessment], locale)}</Badge></TableHead>
                {sources.map(source => {
                  const evidence = claim.evidence[source.id]
                  const reviewed = !!state.reviewed[claim.id + ":" + source.id]
                  return <TableCell key={source.id} className={styles.sourceCell}><Button variant="ghost" className={styles.evidenceCell} data-focus-id={claim.id + ":" + source.id} data-relation={evidence.relation} aria-pressed={claim.id === selected?.id && state.selectedSource === source.id} aria-label={locale === "en" ? `Inspect ${text(source.title, locale)} for ${text(claim.title, locale)}` : `查看“${text(claim.title, locale)}”的${text(source.title, locale)}`} onClick={() => dispatch({ type: "select", claimId: claim.id, sourceId: source.id })}>
                    <span className={styles.cellTop}>{relationLabel(evidence.relation)}{reviewed && <Check size={14} aria-label={l("已审阅", "Reviewed")} className={styles.reviewedCheck} />}</span>
                    <span className={styles.excerpt}>{text(evidence.quote ?? evidence.interpretation, locale)}</span>
                  </Button></TableCell>
                })}
              </TableRow>)}
            </TableBody>
          </Table>
        </TableContainer>
        {!visible.length && <DataRegion state="empty" emptyTitle={l("没有匹配的主张", "No matching claims")} emptyDescription={l("清除筛选以查看全部证据。", "Clear the filter to see all evidence.")} emptyAction={<Button variant="secondary" onClick={() => dispatch({ type: "filter", filter: "all" })}>{l("清除筛选", "Clear filter")}</Button>} />}
        {selected && <section className={styles.reader} aria-label={l("选中主张的证据", "Selected claim evidence")}>
          <div className={styles.readerHeader}><div><p>{l("将来源放在一起阅读", "Read the sources together")}</p><h2>{text(selected.title, locale)}</h2></div><Badge size="sm">{text(assessments[selected.assessment], locale)}</Badge></div>
          <div className={styles.sourceArticles}>
            {sources.map(source => {
              const evidence = selected.evidence[source.id]
              const reviewed = !!state.reviewed[selected.id + ":" + source.id]
              return <article key={source.id} className={styles.article} data-focused={source.id === state.selectedSource}>
                <div className={styles.articleHeader}><h3>{text(source.title, locale)}</h3>{relationLabel(evidence.relation)}</div>
                {evidence.quote && <blockquote>{text(evidence.quote, locale)}</blockquote>}
                <p className={styles.interpretation}>{text(evidence.interpretation, locale)}</p>
                <Button variant="ghost" size="sm" className={styles.reviewButton} data-focus-id={"review-" + selected.id + ":" + source.id} disabled={!state.canReview} aria-describedby={!state.canReview ? "matrix-readonly" : undefined} aria-pressed={reviewed} aria-label={locale === "en" ? `Mark ${text(source.title, locale)} as ${reviewed ? "unreviewed" : "reviewed"}` : `将${text(source.title, locale)}标记为${reviewed ? "未审阅" : "已审阅"}`} onClick={() => dispatch({ type: "review", claimId: selected.id, sourceId: source.id })}>{reviewed && <Check size={14} aria-hidden="true" />}{reviewed ? l("已审阅", "Reviewed") : l("标记为已审阅", "Mark as reviewed")}</Button>
              </article>
            })}
          </div>
        </section>}
        <div className={styles.legend} aria-label={l("证据关系图例", "Evidence relationship legend")}>{(["supports", "conflicts", "qualifies", "none"] as const).map(relation => <span key={relation}>{relationLabel(relation)}</span>)}</div>
        <p className={styles.disclaimer}>{l("一致只表示该样本内的观点相符，而非证明。设计提案是假设，不是独立的研究证据。", "Agreement shows alignment within this sample, not proof. The design proposal is a hypothesis and is not independent research evidence.")}</p>
      </DataRegion>
      {state.data === "loading" && <Button variant="secondary" data-focus-id="finish-loading" onClick={() => dispatch({ type: "load-fixture" })}>{l("完成演示加载", "Finish demo loading")}</Button>}
    </div>
  </div>
}
