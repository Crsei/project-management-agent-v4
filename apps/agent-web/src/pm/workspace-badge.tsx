import { BriefcaseBusiness, Building2, Globe, Grid2X2, Layers, Rocket } from "lucide-react";
import { WORKSPACE_COLORS, WORKSPACE_ICONS, type WorkspaceColor, type WorkspaceIcon } from "../../../../packages/domain/src/workspace-identity";

const icons = { building: Building2, grid: Grid2X2, briefcase: BriefcaseBusiness, layers: Layers, rocket: Rocket, globe: Globe };

/** Mirrors PM's fixed local badge: server-owned icon/color only, never arbitrary CSS or remote images. */
export function WorkspaceBadge({ icon, color, className }: { icon?: WorkspaceIcon; color?: WorkspaceColor; className?: string }) {
  const Icon = icon && WORKSPACE_ICONS.includes(icon) ? icons[icon] : Building2;
  const safeColor = color && WORKSPACE_COLORS.includes(color) ? color : WORKSPACE_COLORS[0];
  return <span aria-hidden="true" className={className ? `pm-agent-workspace-badge ${className}` : "pm-agent-workspace-badge"} style={{ backgroundColor: safeColor }}><Icon strokeWidth={1.75} /></span>;
}
