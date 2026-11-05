import React from "react";
import UnifiedSkillsPanel from "@pm/cc-switch-source/components/skills/UnifiedSkillsPanel";
import { Button } from "@pm/cc-switch-source/components/ui/button";
import { hasUnsavedChanges } from "@pm/cc-switch-source/lib/unsavedChanges";
import { OpenHandsInstalledSkills } from "@pm/openhands-source/web/skills/installed-skills";
import { OpenHandsDiscoveredSkills } from "@pm/openhands-source/web/skills/discovered-skills";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import "@pm/openhands-source/web/skills/skills.css";

export interface OpenHandsSkillsPageProps {
  onInteractionBlockedChange?: (blocked: boolean) => void;
}

/** OpenHands source cards/facets/details on the existing CC Switch Rust lifecycle host. */
export function OpenHandsSkillsPage({ onInteractionBlockedChange }: OpenHandsSkillsPageProps) {
  const { t } = useOpenHandsTranslation();
  const [advanced, setAdvanced] = React.useState(false);
  const [blocked, setBlocked] = React.useState(false);
  const reportBlocked = React.useCallback((next: boolean) => {
    setBlocked(next);
    onInteractionBlockedChange?.(next);
  }, [onInteractionBlockedChange]);
  return <main data-testid="skills-settings-screen" className="oh-skills-page" data-presentation={advanced ? "advanced" : "cards"}>
    <div className="oh-skills-presentation-switch">
      <p>{advanced
        ? t("SKILLS_PM$ADVANCED_DESCRIPTION")
        : t("SKILLS_PM$PAGE_DESCRIPTION")}</p>
      <Button variant="quiet" disabled={blocked} aria-pressed={advanced} data-testid="skills-advanced-lifecycle"
        onClick={() => { if (!blocked && !hasUnsavedChanges()) setAdvanced((current) => !current); }}>
        {t(advanced ? "SKILLS_PM$BACK_TO_CARDS" : "SKILLS_PM$ADVANCED")}
      </Button>
    </div>
    <UnifiedSkillsPanel onInteractionBlockedChange={reportBlocked}
      renderInstalled={advanced ? undefined : (state) => <OpenHandsInstalledSkills {...state} />}
      renderDiscovery={advanced ? undefined : (state) => <OpenHandsDiscoveredSkills {...state} />} />
  </main>;
}

export default OpenHandsSkillsPage;
