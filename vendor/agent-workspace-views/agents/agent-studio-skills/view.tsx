"use client"

import { useCallback, useId, useLayoutEffect, useRef, type FormEvent } from "react"
import { ArrowDown, ArrowUp, ArrowUpDown, ArrowUpRight, Check, ChevronDown, Code2, Copy as CopyIcon, Layers, Monitor, Moon, MoreHorizontal, Pencil, Plus, Search, Sun } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import { Skeleton } from "@easyuse-ui/ui/components/ui/skeleton"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@easyuse-ui/ui/components/ui/dialog"
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@easyuse-ui/ui/components/ui/sheet"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@easyuse-ui/ui/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@easyuse-ui/ui/components/ui/table"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { RemainingPageStateProvider, useRemainingPageState } from "../../showcase/state"
import { assignStudioCollection, createStudioSkill, createStudioState, editStudioSkill, openStudioSkill, recoverStudioSkills, saveStudioSkill, sortStudioSkills, visibleStudioSkills } from "./controller"
import { skillCollections, skillTypeLabels, studioAgents, type Copy, type SkillType } from "./fixtures"
import styles from "./skills.module.css"

export const pageScenarios = remainingPageScenarios

function SkillsWorkspace({ scenario, active, host, cache }: RemainingPageProps) {
  const { locale } = useI18n()
  const label = (zh: string, en: string) => locale === "en" ? en : zh
  const copy = (value: Copy) => value[locale]
  const [state, setState] = useRemainingPageState(`agent-studio-skills:${scenario}`, () => createStudioState(scenario))
  const body = useRef<HTMLDivElement>(null)
  const sheetBody = useRef<HTMLDivElement>(null)
  const prefix = useId()
  const loading = state.dataState === "loading"
  const canEdit = !state.readonly && !loading
  const skills = visibleStudioSkills(state, locale)
  const selected = state.skills.find(skill => skill.id === state.selectedId)
  const draft = selected ? state.drafts[selected.id] : undefined
  const collection = skillCollections.find(item => item.id === state.collectionId)
  const scrollKey = `agent-studio-skills:${scenario}:reading`
  const sheetKey = `agent-studio-skills:${scenario}:sheet:${state.selectedId}`
  const restoreSheetBody = useCallback((node: HTMLDivElement | null) => {
    sheetBody.current = node
    if (active && node) node.scrollTop = Number(cache.get(sheetKey) ?? 0)
  }, [active, cache, sheetKey])

  useLayoutEffect(() => {
    if (active && body.current) body.current.scrollTop = Number(cache.get(scrollKey) ?? 0)
    if (active && sheetBody.current) sheetBody.current.scrollTop = Number(cache.get(sheetKey) ?? 0)
  }, [active, cache, scrollKey, sheetKey, locale, host.resolvedTheme])

  function openSkill(id: string) {
    setState(previous => openStudioSkill(previous, id))
  }
  function submitCreate(event: FormEvent) {
    event.preventDefault()
    setState(previous => createStudioSkill(previous, locale, `local-${crypto.randomUUID()}`))
  }
  async function copyName(name: string) {
    try {
      await navigator.clipboard.writeText(name)
      if (active) setState(previous => ({ ...previous, feedback: { "zh-CN": `已复制 ${name}。`, en: `${name} copied.` } }))
    } catch {
      if (active) setState(previous => ({ ...previous, feedback: { "zh-CN": `浏览器未允许复制；可从技能详情选择名称：${name}。`, en: `Clipboard access was not granted. Select the name in skill details: ${name}.` } }))
    }
  }
  const typeOptions = [{ value: "all", label: label("所有类型", "All types") }, ...Object.entries(skillTypeLabels).map(([value, title]) => ({ value, label: copy(title) }))]
  const agentOptions = studioAgents.map(agent => ({ value: agent.id, label: copy(agent.name) }))
  const sortIcon = (field: "name" | "agents") => state.sort?.field !== field ? <ArrowUpDown /> : state.sort.direction === "asc" ? <ArrowUp /> : <ArrowDown />

  return (
    <section className={styles.page} data-studio-skills data-locale={locale} ><header className={styles.businessHeader}>
      <span>{label("技能工作区", "Skills workspace")}</span>
      <div><span className={styles.demo}>{label("示例工作区", "Demo workspace")}</span>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={label("切换主题", "Toggle theme")} />}>
            {host.resolvedTheme === "dark" ? <Moon /> : <Monitor />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => host.setTheme("light")}><Sun />{label("浅色", "Light")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => host.setTheme("dark")}><Moon />{label("深色", "Dark")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => host.setTheme("system")}><Monitor />{label("跟随系统", "System")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
    <div className={styles.scroll} data-studio-scroll ref={body} onScroll={event => cache.set(scrollKey, event.currentTarget.scrollTop)}>
      <div className={styles.content}>
        <div className={styles.heading}>
          <div><h1>{label("技能", "Skills")}</h1><p>{label("共享优秀工作的方式。", "A shared way of doing good work.")}</p></div>
          <Button variant="outline" disabled={!canEdit} onClick={() => setState(previous => ({ ...previous, createOpen: true }))}><Plus />{label("创建技能", "Create skill")}</Button>
        </div>
        {state.readonly && <p className={styles.notice} role="status">{label("只读工作区：可以查看技能、集合与分配；编辑和创建不可用。", "Read-only workspace: inspect skills, collections, and assignments; editing and creation are unavailable.")}</p>}
        {state.dataState === "refresh-error" && <div className={styles.notice} role="alert"><span>{label("刷新失败。保留最后已知的技能和草稿；未连接远程服务。", "Refresh failed. Last-known skills and drafts are retained; no remote service is connected.")}</span><Button variant="outline" onClick={() => setState(recoverStudioSkills)}>{label("重新加载本地示例", "Reload local example")}</Button></div>}
        {state.feedback && <p className={styles.feedback} role="status">{copy(state.feedback)}</p>}
        <section aria-labelledby={`${prefix}-collections`}>
          <div className={styles.sectionHeading}><h2 id={`${prefix}-collections`}>{label("从技能集合开始", "Start with a collection")}</h2><span>{label("为团队的工作方式精心策划", "Curated for the way your team works")}</span></div>
          <div className={styles.collections}>
            {skillCollections.map(item => <article className={styles.collection} key={item.id}>
              <div className={styles.art} data-kind={item.kind} aria-hidden="true">
                {item.kind === "research" && <div className={styles.circles}><i /><i /><i /></div>}
                {item.kind === "engineering" && <div className={styles.codeArt}><span><Code2 /></span><span><Check /></span></div>}
                {item.kind === "support" && <div className={styles.ticketArt}><i /><span /><span /></div>}
                <span className={styles.artCount}>{label(`${item.skillIds.length} 项技能`, `${item.skillIds.length} skills`)}</span>
              </div>
              <div className={styles.collectionBody}><p className={styles.category}>{copy(item.category)}</p><h3>{copy(item.name)}</h3><p className={styles.collectionDescription}>{copy(item.description)}</p><Button variant="ghost" size="sm" className={styles.collectionAction} aria-label={`${label("查看集合", "View collection")}: ${copy(item.name)}`} onClick={() => setState(previous => ({ ...previous, collectionId: item.id }))}>{label("查看集合", "View collection")}<ArrowUpRight /></Button></div>
            </article>)}
          </div>
        </section>
        <section className={styles.workspace} aria-labelledby={`${prefix}-skills`} aria-busy={loading || undefined}>
          <h2 id={`${prefix}-skills`}>{label("工作区技能", "Workspace skills")} <span>{state.skills.length}</span></h2>
          <div className={styles.toolbar}>
            <div className={styles.search}><Search aria-hidden="true" /><Input aria-label={label("搜索工作室技能", "Search studio skills")} placeholder={label("搜索技能或 Agent…", "Search skills or agents…")} value={state.query} disabled={loading} onChange={event => setState(previous => ({ ...previous, query: event.target.value }))} /></div>
            <Select value={state.type} disabled={loading} items={typeOptions} onValueChange={value => { if (value) setState(previous => ({ ...previous, type: value as SkillType | "all" })) }}>
              <SelectTrigger aria-label={label("技能类型", "Skill type")} className={styles.typeSelect}><SelectValue /><ChevronDown size={14} /></SelectTrigger>
              <SelectContent>{typeOptions.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
            {(state.query || state.type !== "all") && <Button variant="ghost" onClick={() => setState(previous => ({ ...previous, query: "", type: "all" }))}>{label("重置", "Reset")}</Button>}
          </div>
          <div className={styles.tableContainer}>
            <Table className={styles.table} aria-label={label("工作区技能", "Workspace skills")}>
              <colgroup><col /><col className={styles.agentColumn} /><col className={styles.updatedColumn} /><col className={styles.actionColumn} /></colgroup>
              <TableHeader><TableRow>
                <TableHead aria-sort={state.sort?.field === "name" ? state.sort.direction === "asc" ? "ascending" : "descending" : "none"}><Button variant="ghost" className={styles.sort} disabled={loading} aria-label={label("按技能排序", "Sort by Skill")} onClick={() => setState(previous => sortStudioSkills(previous, "name"))}>{label("技能", "Skill")}{sortIcon("name")}</Button></TableHead>
                <TableHead aria-sort={state.sort?.field === "agents" ? state.sort.direction === "asc" ? "ascending" : "descending" : "none"}><Button variant="ghost" className={styles.sort} disabled={loading} aria-label={label("按使用者排序", "Sort by Used by")} onClick={() => setState(previous => sortStudioSkills(previous, "agents"))}>{label("使用者", "Used by")}{sortIcon("agents")}</Button></TableHead>
                <TableHead>{label("更新时间", "Updated")}</TableHead><TableHead><span className="sr-only">{label("操作", "Actions")}</span></TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {loading ? [0, 1, 2].map(index => <TableRow key={index} className={styles.skillRow}><TableCell><Skeleton className="h-4 w-44" /><Skeleton className="mt-2 h-3 w-80" /></TableCell><TableCell><Skeleton className="h-4 w-32" /></TableCell><TableCell><Skeleton className="h-3 w-12" /></TableCell><TableCell /></TableRow>) : skills.map(skill => {
                  const agents = studioAgents.filter(agent => skill.agentIds.includes(agent.id))
                  return <TableRow key={skill.id} className={styles.skillRow}>
                    <TableCell><div className={styles.skillIdentity}><Button variant="ghost" className={styles.skillName} onClick={() => openSkill(skill.id)}>{skill.name}</Button><Badge size="sm" className={styles.typeBadge}>{copy(skillTypeLabels[skill.type])}</Badge></div><p className={styles.skillDescription}>{copy(skill.description)}</p></TableCell>
                    <TableCell><Button variant="ghost" className={styles.assigned} aria-label={`${label("管理技能的 Agent 分配", "Manage agents for")} ${skill.name}`} onClick={() => openSkill(skill.id)}><span>{agents[0] ? copy(agents[0].name) : label("未分配", "Unassigned")}</span>{agents.length > 1 && <span className={styles.extraAgents}>+{agents.length - 1}</span>}</Button></TableCell>
                    <TableCell className={styles.updated}>{copy(skill.updated)}</TableCell>
                    <TableCell><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${label("技能操作", "Actions for")} ${skill.name}`} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => openSkill(skill.id)} aria-label={`${label("编辑", "Edit")} ${skill.name}`}><Pencil />{label("编辑技能", "Edit skill")}</DropdownMenuItem><DropdownMenuItem onClick={() => void copyName(skill.name)}><CopyIcon />{label("复制名称", "Copy name")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></TableCell>
                  </TableRow>
                })}
                {!loading && !skills.length && <TableRow><TableCell colSpan={4}><div className={styles.empty}><Layers size={20} /><strong>{state.skills.length ? label("没有匹配的技能", "No matching skills") : label("尚无工作区技能", "No workspace skills yet")}</strong><p>{state.skills.length ? label("尝试其他技能或 Agent 名称，或清除筛选。", "Try a different skill or agent name, or clear the filters.") : label("创建技能，或将集合分配给 Agent。", "Create a skill, or assign a collection to an agent.")}</p><Button variant="outline" disabled={!state.skills.length && !canEdit} onClick={() => setState(previous => state.skills.length ? { ...previous, query: "", type: "all" } : { ...previous, createOpen: true })}>{state.skills.length ? label("清除筛选", "Clear filters") : label("创建技能", "Create skill")}</Button></div></TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
          <div className={styles.summary}><span>{label(`${skills.length} / ${state.skills.length} 项技能`, `${skills.length} of ${state.skills.length} skills`)}</span><span>{label(`${studioAgents.length} 个工作区 Agent`, `${studioAgents.length} workspace agents`)}</span></div>
          {loading && <div className={styles.notice} role="status"><span>{label("正在等待本地示例数据。", "Waiting for local example data.")}</span><Button variant="outline" onClick={() => setState(recoverStudioSkills)}>{label("加载本地示例", "Load local example")}</Button></div>}
        </section>
      </div>
    </div>
    <Dialog open={Boolean(collection)} onOpenChange={open => { if (!open) setState(previous => ({ ...previous, collectionId: null })) }}>
      <DialogContent className={styles.dialog}>
        {collection && <><DialogTitle className={styles.dialogTitle}>{copy(collection.name)}</DialogTitle><DialogDescription className={styles.dialogDescription}>{copy(collection.description)}</DialogDescription><ul className={styles.collectionList}>{collection.skillIds.map(id => <li key={id}><Layers size={16} />{id}</li>)}</ul><label className={styles.field}>{label("将集合分配给", "Assign collection to")}<Select value={state.collectionAgentId} items={agentOptions} onValueChange={value => { if (value) setState(previous => ({ ...previous, collectionAgentId: value })) }}><SelectTrigger className={styles.agentSelect} aria-label={label("将集合分配给", "Assign collection to")}><SelectValue /><ChevronDown size={14} /></SelectTrigger><SelectContent>{agentOptions.map(option => <SelectItem value={option.value} key={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></label><Button disabled={!canEdit} className={styles.fullWidth} onClick={() => setState(previous => assignStudioCollection(previous, collection.id, previous.collectionAgentId))}>{label(`分配 ${collection.skillIds.length} 项技能`, `Assign ${collection.skillIds.length} skills`)}</Button><p className={styles.fixtureHelp}>{label("仅修改本地示例分配；不会运行 Agent。", "Changes local example assignments only; does not run agents.")}</p></>}
      </DialogContent>
    </Dialog>
    <Dialog open={state.createOpen} onOpenChange={open => setState(previous => ({ ...previous, createOpen: open }))}>
      <DialogContent className={styles.dialog}><DialogTitle className={styles.dialogTitle}>{label("创建技能", "Create a skill")}</DialogTitle><DialogDescription className={styles.dialogDescription}>{label("将可重复的流程变成 Agent 可以共享的指令。", "Turn a repeatable process into instructions your agents can share.")}</DialogDescription><form className={styles.createForm} onSubmit={submitCreate}>
        <label className={styles.field} htmlFor={`${prefix}-name`}>{label("名称", "Name")}<Input id={`${prefix}-name`} placeholder="customer-brief" value={state.createDraft.name} required aria-invalid={Boolean(state.createError)} aria-describedby={state.createError ? `${prefix}-create-error` : undefined} onChange={event => setState(previous => ({ ...previous, createError: null, createDraft: { ...previous.createDraft, name: event.target.value } }))} /></label>
        <label className={styles.field} htmlFor={`${prefix}-description`}>{label("描述", "Description")}<Input id={`${prefix}-description`} value={state.createDraft.description} onChange={event => setState(previous => ({ ...previous, createDraft: { ...previous.createDraft, description: event.target.value } }))} /></label>
        <label className={styles.field} htmlFor={`${prefix}-new-instructions`}>{label("指令", "Instructions")}<Textarea id={`${prefix}-new-instructions`} rows={3} value={state.createDraft.instructions} onChange={event => setState(previous => ({ ...previous, createDraft: { ...previous.createDraft, instructions: event.target.value } }))} /></label>
        {state.createError && <p id={`${prefix}-create-error`} className={styles.error} role="alert">{label("已存在同名技能。请使用其他名称。", "A skill with this name already exists. Choose a different name.")}</p>}
        <Button type="submit" disabled={!canEdit || !state.createDraft.name.trim()}>{label("创建技能", "Create skill")}</Button><p className={styles.fixtureHelp}>{label("仅在本地内存中创建；不连接 Provider。", "Created in local memory only; no provider is connected.")}</p>
      </form></DialogContent>
    </Dialog>
    <Sheet open={Boolean(selected)} onOpenChange={open => { if (!open) setState(previous => ({ ...previous, selectedId: null })) }}>
      <SheetContent size={480} className={styles.sheet}>
        {selected && draft && <><SheetHeader className={styles.sheetHeader}><SheetTitle className={styles.sheetTitle}>{selected.name}</SheetTitle><SheetDescription className={styles.sheetDescription}>{copy(selected.description)}</SheetDescription><p className={styles.byline}>{label("作者", "By")} {selected.author} · {label("更新于", "Updated")} {copy(selected.updated)}</p></SheetHeader><SheetBody ref={restoreSheetBody} onScroll={event => cache.set(sheetKey, event.currentTarget.scrollTop)} className={styles.sheetBody}>
          <label className={styles.field} htmlFor={`${prefix}-instructions`}>{label("指令", "Instructions")}<Textarea id={`${prefix}-instructions`} className={styles.instructions} rows={6} readOnly={!canEdit} value={copy(draft.instructions)} onChange={event => setState(previous => editStudioSkill(previous, selected.id, { ...draft, instructions: { "zh-CN": event.target.value, en: event.target.value } }))} /></label>
          <section className={styles.assignments} aria-labelledby={`${prefix}-assigned`}><h3 id={`${prefix}-assigned`}>{label("已分配的 Agent", "Assigned agents")}</h3><p>{label("更新会影响所有选中的 Agent。", "An update affects every selected agent.")}</p><div className={styles.agentChoices}>{studioAgents.map(agent => <label key={agent.id}><Checkbox aria-labelledby={`${prefix}-agent-${agent.id}`} disabled={!canEdit} checked={draft.agentIds.includes(agent.id)} onCheckedChange={checked => setState(previous => editStudioSkill(previous, selected.id, { ...draft, agentIds: checked ? [...draft.agentIds, agent.id] : draft.agentIds.filter(id => id !== agent.id) }))} /><span id={`${prefix}-agent-${agent.id}`}>{copy(agent.name)}</span></label>)}</div></section>
          {!canEdit && <p className={styles.fixtureHelp}>{label("工作区为只读；可以检查当前技能和 Agent 分配。", "Workspace is read-only; inspect the current skill and agent assignments.")}</p>}
        </SheetBody><SheetFooter className={styles.sheetFooter}><Button className={styles.fullWidth} disabled={!canEdit} onClick={() => setState(previous => saveStudioSkill(previous, selected.id))}>{label("保存更改", "Save changes")}</Button><p className={styles.fixtureHelp}>{label("仅保存到本地示例工作区。", "Saved to the local example workspace only.")}</p></SheetFooter></>}
      </SheetContent>
    </Sheet></section>
  )
}

export function RemainingPageView(props: RemainingPageProps) {
  return <RemainingPageStateProvider cache={props.cache}><SkillsWorkspace key={props.scenario} {...props} /></RemainingPageStateProvider>
}
