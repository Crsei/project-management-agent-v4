import React from "react";
import { useTranslation } from "react-i18next";
import { Button, type SkillsDiscoveryPresentation, type DiscoverRow } from "@pm/cc-switch-ui";
import { SkillCard } from "@pm/openhands-source/components/features/skills/skill-card";
import { SkillDetailModal } from "@pm/openhands-source/components/features/skills/skill-detail-modal";
import { extensionModuleCardGridClassName, extensionModuleCardGridContainerClassName } from "@pm/openhands-source/utils/extension-module-card-classes";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { agentName, discoveredSkillInfo } from "./skill-presentation";

/** Presentation only: original source handles discovery, conflict detection and multi-target installs. */
export function OpenHandsDiscoveredSkills(state: SkillsDiscoveryPresentation) {
  const { t } = useOpenHandsTranslation();
  const { t: sourceT } = useTranslation();
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const selected = state.rows.find(row => row.key === selectedKey);
  const action = (row: DiscoverRow) => {
    const status = state.statusOf(row);
    if (status.kind !== "available") return <Button variant="quiet" size="compact" disabled={state.busy} onClick={() => { setSelectedKey(null); state.onShowInstalled(status.skill.id); }}>
      {t(status.kind === "installed" ? "SKILLS_PM$INSTALLED_CONFIGURE" : "SKILLS_PM$REVIEW_CONFLICT")}
    </Button>;
    return <Button variant="neutral" size="compact"
      aria-label={sourceT(state.failures[row.key] ? "skillsPage.discover.retryAria" : "skillsPage.discover.installAria", { name: row.name })}
      disabled={state.busy || state.installTargets.length === 0 || !row.repoOwner}
      onClick={() => state.onInstall(row)}>
      {state.installing.has(row.key) ? t("SKILLS_PM$INSTALLING") : state.failures[row.key] ? t("SKILLS_PM$RETRY_INSTALL") : sourceT("skills.install")}
    </Button>;
  };
  return <div className="oh-skills-discovered">
    {state.installTargets.length === 0 ? <p className="oh-skills-warning">{t("SKILLS_PM$NO_TARGETS")}</p> : null}
    <div className={extensionModuleCardGridContainerClassName}><div className={extensionModuleCardGridClassName}>
      {state.rows.map(row => {
        const status = state.statusOf(row);
        return <SkillCard key={row.key} skill={discoveredSkillInfo(row.skill, state.source)}
          onOpen={() => setSelectedKey(row.key)} action={action(row)} summary={<div className="oh-skill-card-meta">
            <span className="oh-skill-state-badge">{status.kind === "installed" ? t("SKILLS_PM$LIBRARY_STORED") : status.kind === "conflict" ? t("SKILLS_PM$DIRECTORY_CONFLICT", { name: status.skill.name }) : t("SKILLS_PM$CATALOG_LISTING")}</span>
            {state.failures[row.key] ? <p role="alert" className="oh-skill-error">{state.failures[row.key]}</p> : null}
          </div>} />;
      })}
    </div></div>
    {selected ? <SkillDetailModal key={selected.key} skill={discoveredSkillInfo(selected.skill, state.source)} busy={state.busy}
      onClose={() => setSelectedKey(null)} actions={<>
        {selected.skill.readmeUrl || selected.repoOwner && selected.repoName ? <Button variant="quiet" disabled={state.busy} onClick={() => state.onOpenDocs(selected)}>{t("SKILLS_PM$OPEN_SOURCE")}</Button> : null}
        {action(selected)}
      </>}>
      <dl className="oh-skill-metadata">
        <dt>{t("SKILLS_PM$SOURCE")}</dt><dd>{state.source === "skillssh" ? "skills.sh" : t("SKILLS_PM$REPOSITORY_DISCOVERY")} · {selected.repoOwner}/{selected.repoName}</dd>
        <dt>{t("SKILLS_PM$DIRECTORY")}</dt><dd><code>{selected.directory}</code></dd>
        {selected.skill.repoBranch ? <><dt>{t("SKILLS_PM$BRANCH")}</dt><dd><code>{selected.skill.repoBranch}</code></dd></> : null}
        <dt>{t("SKILLS_PM$INSTALL_TARGETS")}</dt><dd>{state.installTargets.map(agentName).join(", ") || t("SKILLS_PM$NONE")}</dd>
      </dl>
      {state.statusOf(selected).kind === "available" && state.installTargets.length === 0 ? <p className="oh-skills-warning">{t("SKILLS_PM$NO_TARGETS")}</p> : null}
      {!selected.repoOwner ? <p className="oh-skills-warning">{t("SKILLS_PM$MISSING_SOURCE")}</p> : null}
      {state.failures[selected.key] ? <p role="alert" className="oh-skill-error">{state.failures[selected.key]}</p> : null}
    </SkillDetailModal> : null}
  </div>;
}
