import type { SkillInfo } from "@pm/openhands-source/types/settings";
import type { InstalledSkill, DiscoverableSkill } from "@pm/cc-switch-source/lib/api/skills";
import type { AppId } from "@pm/cc-switch-source/lib/api/types";
import { APP_DISPLAY_NAME } from "@pm/cc-switch-source/components/shell/AppGlyph";
import { isTargetAvailable } from "@pm/openhands-source/web/bridge";

export interface ManagedSkillInfo extends SkillInfo {
  id: string;
  sourceKind: "repository" | "local" | "skillssh";
  /** Explicit saved application flags; Pi/OMP are deliberately not represented here. */
  assignedAgents: AppId[];
  /** get_installed_skills observes these native directories, rather than trusting DB flags. */
  nativeDiscoveredAgents: AppId[];
  installed: boolean;
}

export const agentName = (app: string) => APP_DISPLAY_NAME[app as AppId] ?? app;
export const isNativeDiscoveryAgent = (app: AppId) => app === "pi" || app === "omp";

export function installedSkillInfo(skill: InstalledSkill, appIds: readonly AppId[]): ManagedSkillInfo {
  const enabled = appIds.filter((app) => isTargetAvailable(app) && Boolean(skill.apps[app]));
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    type: "agentskills",
    source: skill.repoOwner && skill.repoName ? `${skill.repoOwner}/${skill.repoName}` : null,
    sourceKind: skill.repoOwner && skill.repoName ? "repository" : "local",
    installed: true,
    assignedAgents: enabled.filter((app) => !isNativeDiscoveryAgent(app)),
    nativeDiscoveredAgents: enabled.filter(isNativeDiscoveryAgent),
  };
}

export function discoveredSkillInfo(skill: DiscoverableSkill, source: "repos" | "skillssh"): ManagedSkillInfo {
  return {
    id: skill.key,
    name: skill.name,
    description: skill.description,
    type: "agentskills",
    source: `${skill.repoOwner}/${skill.repoName}`,
    sourceKind: source === "skillssh" ? "skillssh" : "repository",
    installed: false,
    assignedAgents: [],
    nativeDiscoveredAgents: [],
  };
}
