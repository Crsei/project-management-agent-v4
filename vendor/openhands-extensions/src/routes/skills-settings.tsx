import React from "react";
import { UnifiedSkillsPanel, APP_DISPLAY_NAME, type AppId } from "@pm/cc-switch-ui";
import { OpenHandsInstalledSkills } from "@pm/openhands-source/web/skills/installed-skills";
import { OpenHandsDiscoveredSkills } from "@pm/openhands-source/web/skills/discovered-skills";
import { isTargetAvailable } from "@pm/openhands-source/web/bridge";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { AgentStack } from "@pm/openhands-source/web/shared/agent-avatar";
import "@pm/openhands-source/web/skills/skills.css";

export interface OpenHandsSkillsPageProps {
  onInteractionBlockedChange?: (blocked: boolean) => void;
}

/** OpenHands source cards/facets/details on the existing CC Switch Rust lifecycle host. */
export function OpenHandsSkillsPage({ onInteractionBlockedChange }: OpenHandsSkillsPageProps) {
  const { t } = useOpenHandsTranslation();
  return <main data-testid="skills-settings-screen" className="oh-skills-page">
    <UnifiedSkillsPanel
      presentation="openhands"
      presentationLabels={{ catalog: t("SKILLS_PM$CATALOG"), discover: t("SKILLS_PM$DISCOVER"), config: t("SKILLS_PM$CONFIG") }}
      onInteractionBlockedChange={onInteractionBlockedChange}
      renderHeader={({ actions, appIds }) => {
        const bound = appIds.filter((app: AppId) => isTargetAvailable(app));
        return <header className="oh-skills-header">
          <div className="oh-skills-header-copy">
            <h2>{t("SKILLS_PM$PAGE_TITLE")}</h2>
            <p>{t("SKILLS_PM$PAGE_DESCRIPTION")}</p>
            {bound.length ? <div className="oh-skills-agent-banner"><AgentStack appIds={bound} size="sm" max={5} /><span>{t("SKILLS_PM$AGENT_BANNER", { agents: bound.map(app => APP_DISPLAY_NAME[app]).join(", ") })}</span></div> : null}
          </div>
          <div className="oh-skills-header-actions">{actions}</div>
        </header>;
      }}
      renderInstalled={(state, mode) => <OpenHandsInstalledSkills state={state} mode={mode ?? "catalog"} />}
      renderDiscovery={(state) => <OpenHandsDiscoveredSkills {...state} />}
    />
  </main>;
}

export default OpenHandsSkillsPage;
