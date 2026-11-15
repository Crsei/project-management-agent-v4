import { Link } from "react-router"
import { MemberAvatar, type PeopleIdentity } from "./people-components"
import { usePmService, useProjectDirectory } from "./pm-service"
import { useText } from "./pm-ui"

/** Resolve display identities only from authorized relation fragments, never from assignment choices. */
function useHumanIdentity(userId: string | null | undefined, projectId?: string) {
  const { actor, workspace } = usePmService()
  const directory = useProjectDirectory()
  const projects = !directory.error ? directory.data?.projects : undefined
  const identity = userId ? projects?.find(project => (!projectId || project.projectId === projectId) && project.identities.some(person => person.id === userId))?.identities.find(person => person.id === userId) : undefined
  const member: PeopleIdentity | null = userId && actor?.id === userId ? { userId, name: actor.name } : identity ? { userId: identity.id, name: identity.name } : null
  return { member, workspace, error: directory.error }
}

export function HumanIdentity({ userId, projectId, name, avatarDataUrl, showName = true, size = 24 }: {
  userId: string | null | undefined
  projectId?: string
  name?: string | null
  avatarDataUrl?: string | null
  showName?: boolean
  size?: 20 | 24 | 32 | 36 | 40
}) {
  const resolved = useHumanIdentity(userId, projectId)
  const t = useText()
  if (!userId) return <span className="text-muted-foreground">{t("未分配", "Unassigned")}</span>
  const member = name ? { userId, name, avatarDataUrl } : resolved.member
  if (member && resolved.workspace) return <MemberAvatar member={member} workspaceSlug={resolved.workspace.id} size={size} showName={showName} />
  return resolved.workspace ? <Link className="text-muted-foreground hover:underline" title={userId} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} to={`/pm/${encodeURIComponent(resolved.workspace.id)}/members?person=${encodeURIComponent(userId)}`}>{t("身份不可用", "Identity unavailable")}</Link> : <span className="text-muted-foreground">{t("身份不可用", "Identity unavailable")}</span>
}
