import { useEffect, useRef, useState } from "react"
import { MEMBER_ROLE_PRESETS, type MemberRole } from "@contracts"
import { Button } from "@/components/ui/button"
import { pmKeys } from "./pm-data"
import { usePmService, usePrivateQuery } from "./pm-service"
import { Field, useText } from "./pm-ui"
import { capabilityChanges } from "./member-invitation-model"

export function MemberScopeFields({ whole, setWhole, projects, setProjects, options, admin = false }: { whole: boolean; setWhole: (value: boolean) => void; projects: string[]; setProjects: (value: string[]) => void; options: readonly { id: string; name: string }[]; admin?: boolean }) {
  const t = useText()
  return <div className="space-y-2"><label className="flex gap-2 text-sm"><input type="checkbox" checked={admin || whole} disabled={admin} onChange={event => setWhole(event.target.checked)} />{t("整个工作区", "Whole workspace")}</label>{admin && <p className="text-xs text-muted-foreground">{t("Admin 必须覆盖整个工作区。", "Admin requires workspace-wide scope.")}</p>}{!admin && !whole && <fieldset className="max-h-56 space-y-2 overflow-y-auto rounded border p-3"><legend className="text-sm">{t("授权项目（团队不授予权限）", "Authorized projects (teams grant no access)")}</legend>{options.map(project => <label key={project.id} className="flex gap-2 text-sm"><input type="checkbox" checked={projects.includes(project.id)} onChange={event => setProjects(event.target.checked ? [...projects, project.id] : projects.filter(id => id !== project.id))} />{project.name}</label>)}{projects.some(id => !options.some(project => project.id === id)) && <p role="alert">{t("原选项目已不可用，请明确清除后重新选择。", "A selected project is unavailable. Clear it explicitly and select again.")} <Button type="button" variant="outline" onClick={() => setProjects(projects.filter(id => options.some(project => project.id === id)))}>{t("清除不可用项目", "Clear unavailable projects")}</Button></p>}</fieldset>}</div>
}

export function MemberCapabilityPreview({ before, role, after }: { before: readonly string[]; role?: string; after?: readonly string[] }) {
  const t = useText()
  const preset = role === "admin" || role === "member" || role === "guest" ? MEMBER_ROLE_PRESETS[role as MemberRole] : after
  if (!preset) return null
  const changes = capabilityChanges(before, preset)
  return <section className="space-y-2 rounded border p-3 text-sm" aria-label={t("实际权限变更预览", "Actual capability change preview")}><p>{t("保存会替换现有能力，不是叠加权限。", "Saving replaces existing capabilities; it does not add a role on top.")}</p>{([["新增", "Added", changes.added], ["移除", "Removed", changes.removed], ["保留", "Retained", changes.retained]] as const).map(([zh, en, values]) => <p key={en}><strong>{t(zh, en)}: </strong>{values.join(", ") || t("无", "None")}</p>)}</section>
}

export function ExistingAccountPicker({ selected, onSelect, disabled, onValidity }: { selected: string; onSelect: (userId: string) => void; disabled: boolean; onValidity: (valid: boolean) => void }) {
  const t = useText()
  const { actor, workspace } = usePmService()
  const [q, setQ] = useState("")
  const [after, setAfter] = useState<string | undefined>()
  const [email, setEmail] = useState("")
  const [lookupEmail, setLookupEmail] = useState("")
  const key = [...pmKeys.workspace(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "people", "grant-picker"]
  const candidates = usePrivateQuery([...key, "candidates", q, after ?? ""], "access.manage", undefined, (client, id, signal) => client.people.candidates(id, { purpose: "team", q, ...(after ? { after } : {}), limit: 50 }, signal), !disabled)
  const lookup = usePrivateQuery([...key, "account", lookupEmail], "access.manage", undefined, (client, id, signal) => client.people.lookupAccount(id, lookupEmail, signal), !!lookupEmail && !disabled)
  const valid = !disabled && !candidates.error && !lookup.error && (!!candidates.data?.items.some(person => person.userId === selected) || lookup.data?.account?.userId === selected)
  const reportValidity = useRef(onValidity)
  reportValidity.current = onValidity
  useEffect(() => { reportValidity.current(valid) }, [valid])
  return <fieldset disabled={disabled} className="space-y-3"><legend className="text-sm">{t("选择现有账号（不会发送邀请）", "Select an existing account (no invitation email)")}</legend><Field label={t("搜索工作区成员", "Search workspace members")} value={q} onChange={value => { setQ(value); setAfter(undefined); onSelect("") }} />{candidates.error ? <p role="alert">{t("候选读取失败，不能使用旧结果。", "Candidates could not be read; stale results are unavailable.")}<Button type="button" variant="outline" onClick={() => { void candidates.refetch() }}>{t("重试", "Retry")}</Button></p> : candidates.data && <><select aria-label={t("现有工作区成员", "Existing workspace member")} className="w-full rounded border bg-background p-2" value={selected} onChange={event => onSelect(event.target.value)}><option value="">{t("请选择", "Choose a person")}</option>{candidates.data.items.map(person => <option key={person.userId} value={person.userId}>{person.name}{person.jobTitle ? ` · ${person.jobTitle}` : ""}</option>)}</select><div className="flex gap-2">{after && <Button type="button" variant="outline" onClick={() => setAfter(undefined)}>{t("第一页", "First page")}</Button>}{candidates.data.nextCursor && <Button type="button" variant="outline" onClick={() => { setAfter(candidates.data!.nextCursor!); onSelect("") }}>{t("更多成员", "More people")}</Button>}</div></>}
    <Field label={t("或精确查找已有账号邮箱", "Or find an existing account by exact email")} value={email} type="email" onChange={value => { setEmail(value); setLookupEmail(""); onSelect("") }} /><Button type="button" variant="outline" disabled={!email.trim()} onClick={() => { onSelect(""); setLookupEmail(email.trim().toLowerCase()) }}>{t("查找此邮箱", "Find this email")}</Button>{lookupEmail && (lookup.error ? <p role="alert">{t("查询失败，不能授权。", "Lookup failed; no grant can be made.")}<Button type="button" variant="outline" onClick={() => { void lookup.refetch() }}>{t("重试", "Retry")}</Button></p> : lookup.data ? lookup.data.account ? <label className="flex gap-2 text-sm"><input type="radio" checked={selected === lookup.data.account.userId} onChange={() => onSelect(lookup.data!.account!.userId)} />{lookup.data.account.name} · {lookupEmail}</label> : <p role="status">{t("没有匹配账号；如需创建账号，请使用邮件邀请。", "No matching account. Use email invitation to create an account.")}</p> : <p role="status">{t("正在查询…", "Looking up…")}</p>)}
  </fieldset>
}
