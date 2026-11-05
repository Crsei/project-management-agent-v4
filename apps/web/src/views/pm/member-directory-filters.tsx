import type { ReactNode } from "react"
import { ListFilter } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { FilterCard } from "@/components/blocks/filter-card"
import type { FilterCondition, FilterField } from "@/lib/filter-model"
import type { ControlledInvitation, ControlledMember, PeopleRoleOption } from "./people-controlled-contracts"

export type MemberDirectoryText = (zh: string, en: string) => string
export type MemberDirectoryFilterOption = { id: string; name: string }

export const memberPresenceValues = ["available", "away", "offline"] as const

export function activeMemberConditionCount(conditions?: readonly FilterCondition[]) {
  return (conditions ?? []).filter(condition => condition.values.length > 0).length
}

/** Shared FilterCard semantics: conditions AND together, values OR, `isNot` negates.
 * Empty value lists and unknown fields never narrow the directory. */
export function matchesMemberConditions(member: ControlledMember, conditions?: readonly FilterCondition[]): boolean {
  return (conditions ?? []).every(condition => {
    if (!condition.values.length) return true
    const matched = condition.values.some(value => {
      if (condition.field === "role") return String(member.role) === value
      if (condition.field === "presence") return member.presence === value
      if (condition.field === "status") return value === "active" ? member.isActive : value === "inactive" ? !member.isActive : false
      if (condition.field === "security") return member.twoFactor == null ? false : value === "enrolled" ? member.twoFactor : value === "missing" ? !member.twoFactor : false
      if (condition.field === "team") return (member.teams ?? []).some(team => team.id === value)
      return false
    })
    return condition.operator === "is" ? matched : !matched
  })
}

/** Invitation rows only carry a role, so only role conditions narrow them. */
export function matchesInvitationConditions(invitation: ControlledInvitation, conditions?: readonly FilterCondition[]): boolean {
  return (conditions ?? []).filter(condition => condition.field === "role").every(condition => {
    if (!condition.values.length) return true
    const matched = condition.values.some(value => String(invitation.role) === value)
    return condition.operator === "is" ? matched : !matched
  })
}

/** Fields are limited to facts the directory actually provides. */
export function memberDirectoryFilterFields(text: MemberDirectoryText, options: {
  roles: readonly PeopleRoleOption[]
  roleAvailable: boolean
  presenceAvailable: boolean
  securityAvailable: boolean
  teams?: readonly MemberDirectoryFilterOption[] | undefined
}): FilterField[] {
  const fields: FilterField[] = []
  if (options.roleAvailable && options.roles.length) fields.push({
    id: "role", label: text("角色", "Role"),
    options: options.roles.map(role => ({ value: String(role.value), label: role.label })),
  })
  if (options.presenceAvailable) fields.push({
    id: "presence", label: text("可用性", "Presence"),
    options: memberPresenceValues.map(presence => ({
      value: presence,
      label: presence === "available" ? text("在线", "Available") : presence === "away" ? text("离开", "Away") : text("离线", "Offline"),
    })),
  })
  fields.push({
    id: "status", label: text("成员状态", "Status"), single: true,
    options: [
      { value: "active", label: text("有效成员", "Active membership") },
      { value: "inactive", label: text("已停用成员", "Inactive membership") },
    ],
  })
  if (options.securityAvailable) fields.push({
    id: "security", label: text("安全", "Security"), single: true,
    options: [
      { value: "enrolled", label: text("已启用 2FA", "2FA enabled") },
      { value: "missing", label: text("未启用 2FA", "2FA disabled") },
    ],
  })
  if (options.teams?.length) fields.push({
    id: "team", label: text("团队", "Team"),
    options: options.teams.map(team => ({ value: team.id, label: team.name })),
  })
  return fields
}

export function MemberDirectoryFilter({ text, label, fields, conditions, onChange, disabled, variant = "outline", className, dataPm, header, align = "end", activeCount }: {
  text: MemberDirectoryText
  label: string
  fields: readonly FilterField[]
  conditions: readonly FilterCondition[]
  onChange: (conditions: FilterCondition[]) => void
  disabled?: boolean
  variant?: "ghost" | "outline" | "secondary"
  className?: string
  dataPm?: boolean
  header?: ReactNode
  align?: "start" | "end" | "center"
  /** Let a view include search or other hosts-owned filters in the badge. */
  activeCount?: number
}) {
  const active = activeCount ?? activeMemberConditionCount(conditions)
  return <Popover>
    <PopoverTrigger render={<Button variant={variant} className={className} disabled={disabled} aria-label={active ? `${label} · ${active}` : label} aria-pressed={active > 0} data-pm-filter-trigger={dataPm ? "" : undefined} />}>
      <ListFilter aria-hidden="true" size={16} />
      <span>{label}</span>
      {active > 0 && <Badge size="sm" tone="info">{active}</Badge>}
    </PopoverTrigger>
    <PopoverContent align={align} className="w-[420px] max-w-[calc(100vw-2rem)] p-0" aria-label={label}>
      {header}
      <FilterCard
        title={label}
        fields={fields}
        conditions={conditions}
        onChange={onChange}
        emptyHint={text("尚未添加筛选条件。", "No conditions yet.")}
        addLabel={text("添加条件", "Add condition")}
        clearLabel={text("清除条件", "Clear conditions")}
        whereLabel={text("条件", "Where")}
        andLabel={text("并且", "and")}
        anyLabel={text("任意", "Any")}
        removeLabel={text("移除条件", "Remove condition")}
        disabled={disabled}
      />
    </PopoverContent>
  </Popover>
}
