import { Fragment, useRef, type ReactElement } from "react"
import { MoreHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useI18n } from "@/lib/i18n-provider"
import type { ControlledMember, MemberDirectoryViewProps } from "./people-controlled-contracts"

type MemberAction = {
  id: string
  label: string
  disabled: boolean
  reason?: string
  separator?: boolean
  opensDialog?: boolean
  run: () => void
}

type MemberActionProps = {
  surface: MemberDirectoryViewProps
  member: ControlledMember
  selectable?: boolean
}

function memberActions({ surface, member, selectable }: MemberActionProps, trigger: () => HTMLElement | null, text: (zh: string, en: string) => string): MemberAction[] {
  const { readModel: model, capabilities, actions, interaction } = surface
  const loading = model.data.state === "loading"
  const canOpen = !loading && capabilities.memberOpen(member)
  const unavailable = text("当前读取或权限状态不允许此操作。", "Current read or permission state does not allow this action.")
  const items: MemberAction[] = [{
    id: "inspect", label: text("成员明细", "Member details"), disabled: !canOpen, reason: !canOpen ? unavailable : undefined,
    opensDialog: true, run: () => actions.memberOpen(member, trigger()),
  }]
  if (actions.memberWorkload) items.push({
    id: "workload", label: text("查看成员工作量", "View member workload"), disabled: !canOpen, reason: !canOpen ? unavailable : undefined,
    run: () => actions.memberWorkload!(member),
  })
  if (actions.copyContact && capabilities.copyContact) {
    for (const kind of ["email", "phone"] as const) {
      const available = !!(kind === "email" ? member.email : member.phone)
      const enabled = !loading && available && capabilities.copyContact(member, kind)
      items.push({
        id: `copy-${kind}`, label: kind === "email" ? text("复制邮箱", "Copy email") : text("复制电话", "Copy phone"),
        disabled: !enabled, separator: kind === "email",
        reason: !enabled ? available ? unavailable : text("当前授权目录未提供此联系方式。", "This contact information is unavailable in the authorized directory.") : undefined,
        run: () => { const element = trigger(); if (element) actions.copyContact!(member, kind, element) },
      })
    }
  }
  const canEditRole = !loading && (member.isOwner || model.roles.some(role => role.value === member.role)) && capabilities.editRole(member)
  items.push({
    id: "role", label: text("更改角色", "Change role"), disabled: !canEditRole, separator: true,
    reason: !canEditRole ? unavailable : undefined, opensDialog: true, run: () => actions.editRole(member, trigger()),
  })
  if (actions.manageAccess) {
    const enabled = !loading && !!capabilities.manageAccess?.(member)
    items.push({
      id: "access", label: text("管理访问", "Manage access"), disabled: !enabled, reason: !enabled ? unavailable : undefined,
      opensDialog: true, run: () => actions.manageAccess!(member, trigger()),
    })
  }
  if (selectable) items.push({
    id: "select", label: interaction.selectedIds.includes(member.membershipId) ? text("取消选择成员", "Deselect member") : text("选择成员", "Select member"),
    disabled: loading, separator: true, reason: loading ? unavailable : undefined,
    run: () => actions.setInteraction(previous => ({ ...previous, selectedIds: previous.selectedIds.includes(member.membershipId) ? previous.selectedIds.filter(id => id !== member.membershipId) : [...previous.selectedIds, member.membershipId] })),
  })
  return items
}

export function MemberDirectoryContextMenu({ children, ...props }: MemberActionProps & { children: ReactElement }) {
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "en" ? en : zh
  const trigger = useRef<HTMLElement | null>(null)
  const dialogSelected = useRef(false)
  const items = memberActions(props, () => trigger.current, text)
  return <ContextMenu onOpenChange={open => { if (open) dialogSelected.current = false }}>
    <ContextMenuTrigger asChild ref={element => { trigger.current = element }}>{children}</ContextMenuTrigger>
    <ContextMenuContent onCloseAutoFocus={event => { if (dialogSelected.current) event.preventDefault() }}>
      {items.map(action => <Fragment key={action.id}>{action.separator && <ContextMenuSeparator />}<ContextMenuItem disabled={action.disabled} title={action.reason} onSelect={() => { if (!action.disabled) { dialogSelected.current = !!action.opensDialog; action.run() } }}>{action.label}</ContextMenuItem></Fragment>)}
    </ContextMenuContent>
  </ContextMenu>
}

export function MemberDirectoryActionsMenu({ className, menuClassName, ...props }: MemberActionProps & { className?: string; menuClassName?: string }) {
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "en" ? en : zh
  const trigger = useRef<HTMLButtonElement | null>(null)
  const dialogSelected = useRef(false)
  const items = memberActions(props, () => trigger.current, text)
  return <DropdownMenu onOpenChange={open => { if (open) dialogSelected.current = false }}>
    <DropdownMenuTrigger render={<Button ref={trigger} id={`pm-member-actions-${props.member.membershipId}`} variant="ghost" size="icon" className={className} disabled={props.surface.readModel.data.state === "loading"} aria-label={text(`${props.member.name} (${props.member.membershipId}) 的操作`, `Actions for ${props.member.name} (${props.member.membershipId})`)} />}><MoreHorizontal aria-hidden="true" size={16} /></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className={menuClassName} onCloseAutoFocus={event => { if (dialogSelected.current) event.preventDefault() }}>
      {items.map(action => <Fragment key={action.id}>{action.separator && <DropdownMenuSeparator />}<DropdownMenuItem disabled={action.disabled} title={action.reason} onSelect={() => { if (!action.disabled) { dialogSelected.current = !!action.opensDialog; action.run() } }}>{action.label}</DropdownMenuItem></Fragment>)}
    </DropdownMenuContent>
  </DropdownMenu>
}
