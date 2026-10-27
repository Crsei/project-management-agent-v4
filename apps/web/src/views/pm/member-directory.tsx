import { useRef } from "react"
import { ControlledFocus } from "./controlled-presentation"
import { MemberList1View } from "./member-directory-1"
import { MemberList2View } from "./member-directory-2"
import { MemberList3View } from "./member-directory-3"
import { PeopleMemberInspector, type PeopleContactControls } from "./people-views"
import type { MemberDirectoryViewProps } from "./people-controlled-contracts"

const views = { member1: MemberList1View, member2: MemberList2View, member3: MemberList3View }

export function MemberDirectoryView(props: MemberDirectoryViewProps) {
  const { readModel: model, interaction: state, capabilities, actions } = props
  const detailTrigger = useRef<HTMLElement | null>(null)
  const selected = model.selectedMember === undefined
    ? model.members.find((member) => member.membershipId === state.selectedId)
    : model.selectedMember
  const selectedTeams = selected
    ? model.teams.filter((team) => team.members.some((entry) => entry.userId === selected.userId))
    : []
  const contactControls: PeopleContactControls | undefined = selected && actions.copyContact && capabilities.copyContact
    ? { canCopy: (kind) => capabilities.copyContact!(selected, kind), copy: (kind, trigger) => actions.copyContact!(selected, kind, trigger), receipt: model.copyReceipt }
    : undefined
  const memberInspector = props.memberInspector !== undefined ? props.memberInspector : <PeopleMemberInspector
    member={selected}
    teamsAvailable={model.teamsAvailable}
    teams={selectedTeams}
    roles={model.roles}
    open={state.detailOpen}
    onOpenChange={(detailOpen) => actions.setInteraction((previous) => ({ ...previous, detailOpen }))}
    finalFocus={() => detailTrigger.current ?? (props.focusId ? document.getElementById(props.focusId) : null)}
    canEditRole={!!selected && model.data.state !== "loading" && capabilities.editRole(selected)}
    onEditRole={selected ? (trigger) => actions.editRole(selected, trigger) : undefined}
    onWorkload={selected && actions.memberWorkload ? () => actions.memberWorkload!(selected) : undefined}
    contactControls={contactControls}
    readingPosition={state.detailReadingPosition}
    onReadingPositionChange={(detailReadingPosition) => actions.setInteraction((previous) => ({ ...previous, detailReadingPosition }))}
  />
  const View = views[props.variant]
  return <ControlledFocus surface={props}><View {...props} memberInspector={memberInspector} actions={{
    ...actions,
    memberOpen: (member, trigger) => {
      detailTrigger.current = trigger
      actions.memberOpen(member, trigger)
    },
  }} /></ControlledFocus>
}
