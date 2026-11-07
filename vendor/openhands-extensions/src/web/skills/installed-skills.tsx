import React from "react";
import { Button, useSettingsQuery, type SkillsInstalledPresentation } from "@pm/cc-switch-ui";
import { useTranslation } from "react-i18next";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { SkillCard } from "@pm/openhands-source/components/features/skills/skill-card";
import { SkillDetailModal } from "@pm/openhands-source/components/features/skills/skill-detail-modal";
import { SkillFacetRail } from "@pm/openhands-source/components/features/skills/skill-facet-rail";
import { SkillFiltersModal } from "@pm/openhands-source/components/features/skills/skill-filters-modal";
import { SkillsToolbar } from "@pm/openhands-source/components/features/skills/skills-toolbar";
import {
  applySkillFilters, buildSkillFacetGroups, clearSkillFilterFacets, countActiveFilters,
  parseSkillFilterState, toggleSkillFilterValue, type SkillFacetGroupId,
} from "@pm/openhands-source/components/features/skills/skill-filter";
import {
  extensionModuleCardGridClassName, extensionModuleCardGridContainerClassName,
  extensionModuleEmptyStateClassName,
} from "@pm/openhands-source/utils/extension-module-card-classes";
import { AgentStack } from "@pm/openhands-source/web/shared/agent-avatar";
import { installedSkillInfo } from "./skill-presentation";
import { SkillAgentDrawer } from "./skill-agent-drawer";
import { SkillAgentMatrix } from "./skill-agent-matrix";

export function OpenHandsInstalledSkills({ state, mode }: {
  state: SkillsInstalledPresentation;
  mode: "catalog" | "config";
}) {
  const { t } = useOpenHandsTranslation();
  const { t: sourceT } = useTranslation();
  const { data: settings } = useSettingsQuery();
  const [drawerId, setDrawerId] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState(() => parseSkillFilterState(new URLSearchParams()));
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const allSkills = React.useMemo(() => state.skills.map(skill => installedSkillInfo(skill, state.appIds)), [state.skills, state.appIds]);
  const groups = React.useMemo(() => buildSkillFacetGroups(allSkills, filter, {
    state: "SKILLS_PM$ASSIGNMENT_DISCOVERY", source: "SKILLS_PM$SOURCE", agent: "SKILLS_PM$AGENT",
    assigned: "SKILLS_PM$SAVED_ASSIGNED", unassigned: "SKILLS_PM$SAVED_UNASSIGNED",
    native: "SKILLS_PM$NATIVE_DISCOVERED", local: "SKILLS_PM$LOCAL_SOURCE",
  }), [allSkills, filter]);
  const visibleSkills = applySkillFilters(allSkills, filter);
  const activeCount = countActiveFilters(filter);
  const selected = state.skills.find(skill => skill.id === selectedId);
  const selectedInfo = allSkills.find(skill => skill.id === selectedId);
  const drawerSkill = state.skills.find(skill => skill.id === drawerId);
  const toggleFacet = (id: SkillFacetGroupId, value: string) => setFilter(current => toggleSkillFilterValue(current, id, value));
  const clearFacets = () => setFilter(current => clearSkillFilterFacets(current));

  return <>
    {mode === "config" ? <SkillAgentMatrix state={state} onOpen={setDrawerId} /> : <div data-testid="skills-page" className="oh-skills-cards flex min-h-0 flex-1 flex-col gap-4">
    {settings?.skillStorageLocation === "unified" ? <div className="oh-skills-notice oh-skills-warning" role="note">{sourceT("skills.storageSheet.unifiedWarning")}</div> : null}
    <SkillsToolbar search={filter.query} onSearchChange={query => setFilter(current => ({ ...current, query }))}
      activeFilterCount={activeCount} onOpenFilters={() => setFiltersOpen(true)} />
    <div className="oh-skills-library">
      <SkillFacetRail groups={groups} onToggle={toggleFacet} className="oh-skills-facet-rail hidden w-52 shrink-0 self-start md:flex" />
      <section className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="oh-skills-result-bar">
          <span data-testid="skills-result-summary" role="status">{t("SETTINGS$SKILLS_RESULT_COUNT", { count: visibleSkills.length })}</span>
          {activeCount ? <button type="button" onClick={clearFacets} className="cursor-pointer underline">{t("SETTINGS$SKILLS_CLEAR_FILTERS")}</button> : null}
        </div>
        {visibleSkills.length ? <div className={extensionModuleCardGridContainerClassName}><div className={extensionModuleCardGridClassName}>
          {visibleSkills.map(skill => <div key={skill.id} id={`sk-row-${skill.id}`} tabIndex={-1}>
            <SkillCard skill={skill} onOpen={() => setSelectedId(skill.id)}
              summary={skill.assignedAgents.length || state.updates[skill.id] ? <div className="oh-skill-card-meta">
                {skill.assignedAgents.length ? <div className="oh-skill-coverage">
                  <AgentStack appIds={skill.assignedAgents} size="sm" max={3} />
                  <span>{skill.assignedAgents.length === 1 ? t("SKILLS_PM$AGENTS_ONE") : t("SKILLS_PM$AGENTS", { count: skill.assignedAgents.length })}</span>
                </div> : null}
                {state.updates[skill.id] ? <span className="oh-skill-state-badge oh-skill-update-badge">{t("SKILLS_PM$UPDATE_AVAILABLE")}</span> : null}
              </div> : null}
            />
          </div>)}
        </div></div> : <div data-testid="skills-empty" className={extensionModuleEmptyStateClassName}>
          <p>{t(state.skills.length ? "SKILLS_PM$FILTER_EMPTY" : "SKILLS_PM$LIBRARY_EMPTY")}</p>
          {filter.query || activeCount ? <Button variant="quiet" onClick={() => setFilter(parseSkillFilterState(new URLSearchParams()))}>{t("SETTINGS$SKILLS_CLEAR_FILTERS")}</Button> : null}
        </div>}
      </section>
    </div>
    {filtersOpen ? <SkillFiltersModal groups={groups} activeCount={activeCount} onToggle={toggleFacet} onClearAll={clearFacets} onClose={() => setFiltersOpen(false)} /> : null}
    {selected && selectedInfo ? <SkillDetailModal key={selected.id} skill={selectedInfo} busy={state.busy} onClose={() => setSelectedId(null)} actions={<>
      <Button variant="neutral" disabled={state.busy} onClick={() => { setSelectedId(null); setDrawerId(selected.id); }}>{t("SKILLS_PM$CONFIGURE")}</Button>
      <Button variant="neutral" disabled={state.busy} onClick={() => { setSelectedId(null); state.onOpenDirectory(selected); }}>{t("SKILLS_PM$BROWSE_FILES")}</Button>
      {selected.readmeUrl || selected.repoOwner && selected.repoName ? <Button variant="quiet" disabled={state.busy} onClick={() => state.onOpenDocs(selected)}>{t("SKILLS_PM$OPEN_SOURCE")}</Button> : null}
      {state.updates[selected.id] ? <Button variant="neutral" disabled={state.busy} onClick={() => state.onUpdate(selected.id)}>{sourceT("skills.update")}</Button> : null}
      <Button variant="quiet" disabled={state.busy} onClick={() => { setSelectedId(null); state.onUninstall(selected.id); }}>{t("SKILLS_PM$UNINSTALL_BACKUP")}</Button>
    </>}>
      <dl className="oh-skill-metadata">
        <dt>{t("SKILLS_PM$SOURCE")}</dt><dd>{selectedInfo.source || t("SKILLS_PM$SOURCE_UNKNOWN")}</dd>
        <dt>{t("SKILLS_PM$DIRECTORY")}</dt><dd><code>{selected.directory}</code></dd>
        {selected.repoBranch ? <><dt>{t("SKILLS_PM$BRANCH")}</dt><dd><code>{selected.repoBranch}</code></dd></> : null}
        <dt>{t("SKILLS_PM$IDENTIFIER")}</dt><dd><code>{selected.id}</code></dd>
        {selected.contentHash ? <><dt>{t("SKILLS_PM$CONTENT_HASH")}</dt><dd><code>{selected.contentHash}</code></dd></> : null}
      </dl>
    </SkillDetailModal> : null}
    </div>}
    {drawerSkill ? <SkillAgentDrawer key={drawerSkill.id} skill={drawerSkill} state={state} onClose={() => setDrawerId(null)} /> : null}
  </>;
}
