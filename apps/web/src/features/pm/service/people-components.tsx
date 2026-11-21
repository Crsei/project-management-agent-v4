import { useId, type ReactNode } from "react"
import { Link } from "react-router"
import { Avatar, type AvatarProps } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { RadixSelect } from "@/components/ui/radix-select"
import { usePeopleCandidates, type PeopleCandidatePurpose, type PeopleIdentity } from "./people-hooks"
import { useText } from "./pm-ui"

export type { PeopleIdentity } from "./people-hooks"

function stopIdentityPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation()
}

export function MemberAvatar({ member, workspaceSlug, size = 32, showName = false, className = "" }: { member: PeopleIdentity; workspaceSlug: string; size?: AvatarProps["size"]; showName?: boolean; className?: string }) {
  const t = useText()
  return <Link className={`inline-flex min-w-0 items-center gap-2 rounded-md focus-visible:outline focus-visible:outline-2 ${className}`} to={`/pm/${encodeURIComponent(workspaceSlug)}/members?person=${encodeURIComponent(member.userId)}`} onClick={stopIdentityPropagation} onDoubleClick={stopIdentityPropagation} onPointerDown={stopIdentityPropagation} onKeyDown={stopIdentityPropagation} aria-label={t(`查看 ${member.name} 的资料`, `View ${member.name}'s profile`)}><Avatar name={member.name} src={member.avatarDataUrl ?? undefined} size={size} />{showName && <span className="truncate">{member.name}</span>}</Link>
}

export function MemberAvatarGroup({ members, href, max = 4, label }: { members: readonly PeopleIdentity[]; href: string; max?: number; label?: string }) {
  const t = useText()
  const limit = Math.max(1, max)
  return <Link to={href} onClick={stopIdentityPropagation} onDoubleClick={stopIdentityPropagation} onPointerDown={stopIdentityPropagation} onKeyDown={stopIdentityPropagation} className="inline-flex min-h-8 items-center rounded-md focus-visible:outline focus-visible:outline-2" aria-label={label ?? t("查看项目人员", "View project people")}><span className="inline-flex -space-x-2">{members.slice(0, limit).map(member => <Avatar key={member.userId} name={member.name} src={member.avatarDataUrl ?? undefined} size={24} />)}</span>{members.length > limit && <span className="ml-1 text-xs">+{members.length - limit}</span>}{members.length === 0 && <span className="text-xs text-muted-foreground">{label ?? t("项目人员", "Project people")}</span>}</Link>
}

export function MemberIdentityCard({ member, workspaceSlug, children }: { member: PeopleIdentity; workspaceSlug: string; children?: ReactNode }) {
  return <section className="min-w-0 space-y-3 rounded-lg border bg-surface p-4"><MemberAvatar member={member} workspaceSlug={workspaceSlug} size={40} showName />{member.jobTitle && <p className="break-words text-sm text-muted-foreground">{member.jobTitle}</p>}{children}</section>
}

export function MemberStatus({ status }: { status: "active" | "revoked" | "pending" | "unknown" }) {
  const t = useText()
  return <span className="inline-flex rounded-full border px-2 py-0.5 text-xs" data-member-status={status}>{status === "active" ? t("有效成员", "Active member") : status === "revoked" ? t("已撤销", "Revoked") : status === "pending" ? t("待接受邀请", "Invitation pending") : t("访问状态未提供", "Access unavailable")}</span>
}

export function MemberPicker({ purpose, projectId, value, onChange, disabled = false, label, allowUnassigned = true, hideLabel = false }: { purpose: PeopleCandidatePurpose; projectId?: string; value: string | null; onChange: (userId: string | null) => void; disabled?: boolean; label?: string; allowUnassigned?: boolean; hideLabel?: boolean }) {
  const t = useText()
  const id = useId()
  const query = usePeopleCandidates({ purpose, ...(projectId ? { projectId } : {}), enabled: !disabled })
  const unavailable = !!value && !query.items.some(member => member.userId === value)
  const title = label ?? t("选择成员", "Select member")
  return <div className="min-w-0 space-y-2"><label htmlFor={id} className={hideLabel ? "sr-only" : "text-sm"}>{title}</label><RadixSelect id={id} aria-label={title} value={value ?? ""} disabled={disabled || !query.complete} className="min-h-9 w-full rounded-md border bg-background px-2 text-sm" onChange={event => onChange(event.target.value || null)}><option value="" disabled={!allowUnassigned}>{allowUnassigned ? t("未分配", "Unassigned") : t("请选择有效成员", "Choose an eligible member")}</option>{unavailable && <option value={value!} disabled>{t("当前身份不可用（不会作为新候选）", "Current identity unavailable (not eligible)")}</option>}{query.items.map(member => <option key={member.userId} value={member.userId}>{member.name}{member.jobTitle ? ` · ${member.jobTitle}` : ""}</option>)}</RadixSelect>{query.isPending && <p role="status" className="text-xs text-muted-foreground">{t("正在读取全部有效候选…", "Reading eligible candidates…")}</p>}{query.error && <div role="alert" className="text-sm"><p>{query.error.message}</p><Button variant="outline" size="sm" disabled={disabled} onClick={() => { void query.refetch() }}>{t("重新读取", "Read again")}</Button></div>}{query.complete && query.items.length === 0 && <p className="text-xs text-muted-foreground">{t("当前作用域没有有效候选成员。", "No eligible members in this scope.")}</p>}</div>
}
