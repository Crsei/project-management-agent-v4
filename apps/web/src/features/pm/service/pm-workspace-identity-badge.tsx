import { BriefcaseBusiness, Building2, Globe, Grid2X2, Layers, Rocket } from "lucide-react"
import { WORKSPACE_COLORS, type WorkspaceColor, type WorkspaceIcon } from "../../../../../../packages/domain/src/workspace-identity"

const icons = { building: Building2, grid: Grid2X2, briefcase: BriefcaseBusiness, layers: Layers, rocket: Rocket, globe: Globe }

/** Fixed local SVG components and a color allowlist; no remote URLs or arbitrary SVG/CSS. */
export function WorkspaceIdentityBadge({ icon = "building", color = "#2F2E2A", className = "" }: {
  icon?: WorkspaceIcon
  color?: WorkspaceColor
  className?: string
}) {
  const Icon = Object.hasOwn(icons, icon) ? icons[icon] : Building2
  const safeColor = WORKSPACE_COLORS.includes(color) ? color : WORKSPACE_COLORS[0]
  return <span aria-hidden="true" className={`inline-flex size-8 shrink-0 items-center justify-center rounded-control border ${className}`} style={{ backgroundColor: safeColor, color: "#FFFFFF" }}><Icon className="size-4" strokeWidth={1.75} /></span>
}
