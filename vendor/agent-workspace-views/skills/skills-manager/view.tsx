"use client"

import { useId, useLayoutEffect, useRef, type FormEvent } from "react"
import { BookOpen, Check, Download, FileText, ListChecks, Monitor, Moon, Plus, Search, Sun, Trash2 } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Card, CardContent, CardFooter } from "@easyuse-ui/ui/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@easyuse-ui/ui/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Item } from "@easyuse-ui/ui/components/ui/item"
import { Skeleton } from "@easyuse-ui/ui/components/ui/skeleton"
import { Switch } from "@easyuse-ui/ui/components/ui/switch"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { useRemainingPageState } from "../../showcase/state"
import { beginInstructionEdit, cancelInstructionEdit, canModifySkills, createSkill, createSkillsState, filterSkills, installedSkills, installSkill, openSkill, recoverSkills, removeSkill, saveInstructions, setSkillEnabled, skillsCounts, validSkillDraft } from "./controller"
import type { Localized } from "./fixtures"
import styles from "./skills-manager.module.css"

export const pageScenarios = remainingPageScenarios

export function RemainingPageView({ scenario, active, host, cache }: RemainingPageProps) {
  const { locale } = useI18n()
  const label = (zh: string, en: string) => locale === "en" ? en : zh
  const copy = (value: Localized) => value[locale]
  const [state, setState] = useRemainingPageState(`skills-manager:${scenario}`, () => createSkillsState(scenario))
  const scroll = useRef<HTMLDivElement>(null)
  const dialogScroll = useRef<HTMLDivElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const dialogOpener = useRef<HTMLButtonElement>(null)
  const previousDialog = useRef(state.dialog)
  const ids = useId()
  const selected = state.skills.find((skill) => skill.id === state.selectedId)
  const recent = filterSkills(state)
  const installed = installedSkills(state)
  const counts = skillsCounts(state)
  const loading = state.dataState === "loading"
  const modifiable = canModifySkills(state)
  const selectedInstalled = Boolean(selected && state.installed.includes(selected.id))
  const scrollKey = `skills-manager:${scenario}:scroll`
  const detailScrollKey = `skills-manager:${scenario}:detail-scroll:${selected?.id}`

  useLayoutEffect(() => {
    if (active && scroll.current) scroll.current.scrollTop = Number(cache.get(scrollKey) ?? 0)
  }, [active, cache, scrollKey, locale, host.resolvedTheme])
  useLayoutEffect(() => {
    if (active && dialogScroll.current) dialogScroll.current.scrollTop = Number(cache.get(detailScrollKey) ?? 0)
  }, [active, cache, detailScrollKey, state.dialog, locale, host.resolvedTheme])

  useLayoutEffect(() => {
    if (active && state.dialog === "detail" && previousDialog.current === "edit") editButton.current?.focus()
    previousDialog.current = state.dialog
  }, [active, state.dialog])

  function submitCreate(event: FormEvent) {
    event.preventDefault()
    setState(createSkill)
  }
  function submitInstructions(event: FormEvent) {
    event.preventDefault()
    setState(saveInstructions)
  }

  return (
    <section className={styles.page} data-skills-manager data-locale={locale} onClickCapture={(event) => {
      if (state.dialog === "closed" && event.target instanceof Element) {
        const button = event.target.closest<HTMLButtonElement>("button")
        if (button) dialogOpener.current = button
      }
    }}><header className={styles.workspaceHeader}>
      <span>{label("技能", "Skills")}</span>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={label("切换主题", "Toggle theme")} />}>
          {host.resolvedTheme === "dark" ? <Moon /> : <Monitor />}
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => host.setTheme("light")}><Sun />{label("浅色", "Light")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => host.setTheme("dark")}><Moon />{label("深色", "Dark")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => host.setTheme("system")}><Monitor />{label("跟随系统", "System")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
    <div className={styles.scroll} ref={scroll} onScroll={(event) => cache.set(scrollKey, event.currentTarget.scrollTop)}>
      <div className={styles.content}>
        <header className={styles.pageHeader}>
          <div><h1>{label("技能", "Skills")}</h1><p>{label("为团队日常工作提供可复用的指令。", "Reusable instructions for your team’s everyday work.")}</p></div>
          <Button disabled={!modifiable} aria-describedby={!modifiable ? `${ids}-permission` : undefined} onClick={() => setState((previous) => ({ ...previous, dialog: "create", selectedId: null }))}><Plus aria-hidden="true" />{label("创建技能", "Create skill")}</Button>
        </header>
        {state.readonly && <div className={styles.notice} role="status" id={`${ids}-permission`}>{label("只读工作空间：可以搜索和查看技能，但不能安装、启用或修改。", "Read-only workspace: search and view skills; installing, enabling, and editing are unavailable.")}</div>}
        {state.dataState === "refresh-error" && <div className={styles.notice} role="alert"><span>{label("技能列表刷新失败。已保留当前技能、启用状态和草稿。", "Skills refresh failed. Current skills, enabled states, and drafts are retained.")}</span><Button variant="outline" size="sm" onClick={() => setState(recoverSkills)}>{label("重新读取本地示例", "Reload local sample")}</Button></div>}
        {loading && <div className={styles.notice} role="status" id={`${ids}-permission`}><span>{label("正在等待本地技能示例。安装与编辑暂不可用。", "Waiting for the local skill sample. Installing and editing are unavailable.")}</span><Button variant="outline" size="sm" onClick={() => setState(recoverSkills)}>{label("载入本地示例", "Load local sample")}</Button></div>}
        <section className={styles.section} aria-labelledby={`${ids}-installed`} aria-busy={loading || undefined}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}><h2 id={`${ids}-installed`}>{label("已安装", "Installed")}</h2><span>{label(`${counts.enabled} 个已启用 · 共 ${counts.installed} 个`, `${counts.enabled} enabled · ${counts.installed} total`)}</span></div>
            <div className={styles.search}><Search aria-hidden="true" /><Input aria-label={label("搜索技能", "Search skills")} placeholder={label("搜索技能…", "Search skills…")} value={state.query} onChange={(event) => setState((previous) => ({ ...previous, query: event.target.value }))} /></div>
          </div>
          {loading ? <div className={styles.installedGrid}>{[0, 1, 2, 3].map((key) => <div key={key} className={styles.installedSkeleton}><Skeleton className="w-1/3" /><Skeleton className="w-4/5" /></div>)}</div> : installed.length ? (
            <ul className={styles.installedGrid} aria-label={label("已安装技能", "Installed skills")}>
              {installed.map((skill) => <li key={skill.id} className={styles.installedCard}>
                <Item className={styles.installedItem} title={copy(skill.name)} description={copy(skill.description)} ariaLabel={label(`查看${copy(skill.name)}`, `View ${copy(skill.name)}`)} onSelect={() => setState((previous) => openSkill(previous, skill.id))} trailing={<Switch checked={state.enabled.includes(skill.id)} disabled={!modifiable} aria-label={label(`启用${copy(skill.name)}`, `Enable ${copy(skill.name)}`)} aria-describedby={state.readonly ? `${ids}-permission` : undefined} onCheckedChange={(checked) => setState((previous) => setSkillEnabled(previous, skill.id, checked))} />} />
              </li>)}
            </ul>
          ) : <div className={styles.empty}><FileText aria-hidden="true" /><h3>{state.query ? label("没有匹配的已安装技能", "No matching installed skills") : label("尚未安装技能", "No skills installed yet")}</h3><p>{state.query ? label("试试其他关键词，或清除搜索。", "Try another keyword or clear your search.") : label("安装下方技能，或创建自己的可复用指令。", "Install a skill below or create your own reusable instructions.")}</p>{state.query && <Button variant="outline" onClick={() => setState((previous) => ({ ...previous, query: "" }))}>{label("清除搜索", "Clear search")}</Button>}</div>}
        </section>
        <hr className={styles.divider} />
        <section className={styles.section} aria-labelledby={`${ids}-recent`} aria-busy={loading || undefined}>
          <div className={styles.sectionHeader}><h2 id={`${ids}-recent`}>{label("最近新增", "Recently added")}</h2><span>{label(`${recent.length} 个技能`, `${recent.length} skills`)}</span></div>
          {loading ? <div className={styles.recentGrid}>{[0, 1, 2, 3].map((key) => <div key={key} className={styles.recentSkeleton}><Skeleton className="w-2/5" /><Skeleton className="w-full" /><Skeleton className="w-3/4" /></div>)}</div> : recent.length ? (
            <ul className={styles.recentGrid} aria-label={label("最近新增技能", "Recently added skills")}>
              {recent.map((skill) => {
                const Icon = skill.icon === "book" ? BookOpen : skill.icon === "list" ? ListChecks : FileText
                const isInstalled = state.installed.includes(skill.id)
                return <li key={skill.id}><Card className={styles.recentCard}>
                  <CardContent className={styles.cardBody}>
                    <div className={styles.cardHeading}><div className={styles.cardIdentity}><span className={styles.skillIcon}><Icon aria-hidden="true" /></span><h3><button type="button" className={styles.titleButton} onClick={() => setState((previous) => openSkill(previous, skill.id))}>{copy(skill.name)}</button></h3></div><span className={styles.added}>{copy(skill.added)}</span></div>
                    <p className={styles.cardDescription}>{copy(skill.description)}</p>
                  </CardContent>
                  <CardFooter className={styles.cardFooter}><span>{label(`作者 ${copy(skill.author)}`, `By ${copy(skill.author)}`)}</span><Button variant="outline" disabled={!isInstalled && !modifiable} aria-describedby={state.readonly && !isInstalled ? `${ids}-permission` : undefined} aria-label={label(`${isInstalled ? "管理" : "安装"}${copy(skill.name)}`, `${isInstalled ? "Manage" : "Install"} ${copy(skill.name)}`)} onClick={() => setState((previous) => isInstalled ? openSkill(previous, skill.id) : installSkill(previous, skill.id))}>{isInstalled ? <Check aria-hidden="true" /> : <Download aria-hidden="true" />}{isInstalled ? label("已安装", "Installed") : label("安装", "Install")}</Button></CardFooter>
                </Card></li>
              })}
            </ul>
          ) : <div className={styles.empty}><BookOpen aria-hidden="true" /><h3>{state.query ? label("没有匹配的技能", "No matching skills") : label("还没有技能", "No skills yet")}</h3><p>{state.query ? label("搜索会同时筛选已安装和最近新增的技能。", "Search filters both installed and recently added skills.") : label("将重复任务的步骤整理成团队技能。", "Turn the steps of a repeatable task into a team skill.")}</p>{state.query ? <Button variant="outline" onClick={() => setState((previous) => ({ ...previous, query: "" }))}>{label("清除搜索", "Clear search")}</Button> : <Button variant="outline" disabled={!modifiable} onClick={() => setState((previous) => ({ ...previous, dialog: "create" }))}>{label("创建技能", "Create skill")}</Button>}</div>}
        </section>
        <p className={styles.sessionNote}>{label("演示工作空间 · 更改仅应用于本次会话。", "Demo workspace · Changes apply to this session.")}</p>
        {state.notice && <p className={styles.feedback} role="status">{copy(state.notice)}</p>}
      </div>
    </div>
    <Dialog open={active && state.dialog !== "closed"} onOpenChange={(open) => { if (!open) setState((previous) => ({ ...previous, dialog: "closed" })) }}>
      <DialogContent className={styles.dialog} finalFocus={dialogOpener}>
        {state.dialog === "create" ? <>
          <div className={styles.dialogHeader}><DialogTitle>{label("创建技能", "Create a skill")}</DialogTitle><DialogDescription>{label("描述一项可重复的任务，以及应如何处理。", "Describe a repeatable task and how it should be handled.")}</DialogDescription></div>
          <form onSubmit={submitCreate} className={styles.form}>
            <Field label={label("名称", "Name")}>{(props) => <Input {...props} autoFocus placeholder={label("例如：账户审查", "e.g. Account review")} value={state.createDraft.name} onChange={(event) => setState((previous) => ({ ...previous, createDraft: { ...previous.createDraft, name: event.target.value } }))} />}</Field>
            <Field label={label("描述", "Description")}>{(props) => <Input {...props} placeholder={label("什么时候应使用这项技能？", "When should this skill be used?")} value={state.createDraft.description} onChange={(event) => setState((previous) => ({ ...previous, createDraft: { ...previous.createDraft, description: event.target.value } }))} />}</Field>
            <Field label={label("指令", "Instructions")}>{(props) => <Textarea {...props} rows={5} placeholder={label("说明步骤、预期输出和重要约束…", "Explain the steps, expected output, and important constraints…")} value={state.createDraft.instructions} onChange={(event) => setState((previous) => ({ ...previous, createDraft: { ...previous.createDraft, instructions: event.target.value } }))} />}</Field>
            <div className={styles.dialogActions}><Button variant="outline" type="button" onClick={() => setState((previous) => ({ ...previous, dialog: "closed", createDraft: { name: "", description: "", instructions: "" } }))}>{label("取消", "Cancel")}</Button><Button type="submit" disabled={!modifiable || !validSkillDraft(state.createDraft)}>{label("创建并启用", "Create and enable")}</Button></div>
          </form>
        </> : selected ? <>
          <div className={styles.dialogHeader}><DialogTitle>{copy(selected.name)}</DialogTitle><DialogDescription>{copy(selected.description)}</DialogDescription></div>
          <div className={styles.detailMeta}><span>{selected.category === "writing" ? label("写作", "Writing") : selected.category === "analysis" ? label("分析", "Analysis") : label("运营", "Operations")}</span><span>{label(`作者 ${copy(selected.author)}`, `By ${copy(selected.author)}`)}</span></div>
          {state.dialog === "edit" ? <form className={styles.form} onSubmit={submitInstructions}>
            <Field label={label("指令", "Instructions")} description={label("仅保存到本地会话。取消恢复已保存的指令；关闭会保留未保存草稿。", "Saved only in this local session. Cancel restores saved instructions; closing retains the unsaved draft.")}>{(props) => <Textarea {...props} autoFocus rows={8} value={state.instructionDrafts[selected.id] ?? ""} onChange={(event) => setState((previous) => ({ ...previous, instructionDrafts: { ...previous.instructionDrafts, [selected.id]: event.target.value } }))} />}</Field>
            <div className={styles.dialogActions}><Button type="button" variant="outline" onClick={() => setState(cancelInstructionEdit)}>{label("取消", "Cancel")}</Button><Button type="submit" disabled={!modifiable || !state.instructionDrafts[selected.id]?.trim()}>{label("保存指令", "Save instructions")}</Button></div>
          </form> : <>
            <div className={styles.instructions} ref={dialogScroll} onScroll={(event) => cache.set(detailScrollKey, event.currentTarget.scrollTop)}><h3>{label("指令", "Instructions")}</h3><p>{state.savedInstructions[selected.id] ?? copy(selected.instructions)}</p></div>
            {state.readonly && <p className={styles.readonlyDetail}>{label("只读：无法安装或修改这项技能。", "Read only: this skill cannot be installed or modified.")}</p>}
            <div className={`${styles.dialogActions} ${styles.detailActions}`}>{selectedInstalled ? <><Button variant="ghost" disabled={!modifiable} onClick={() => setState((previous) => removeSkill(previous, selected.id))}><Trash2 aria-hidden="true" />{label("移除", "Remove")}</Button><Button ref={editButton} variant="outline" disabled={!modifiable} onClick={() => setState((previous) => beginInstructionEdit(previous, locale))}>{label("编辑指令", "Edit instructions")}</Button></> : <Button disabled={!modifiable} onClick={() => setState((previous) => installSkill(previous, selected.id))}><Download aria-hidden="true" />{label("安装技能", "Install skill")}</Button>}</div>
          </>}
        </> : null}
      </DialogContent>
    </Dialog></section>
  )
}
