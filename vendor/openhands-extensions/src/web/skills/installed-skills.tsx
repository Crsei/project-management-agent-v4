import React from "react";
import { useTranslation } from "react-i18next";
import type { SkillsInstalledPresentation } from "@pm/cc-switch-source/components/skills/UnifiedSkillsPanel";
import { Button } from "@pm/cc-switch-source/components/ui/button";
import { isTargetAvailable } from "@pm/openhands-source/web/bridge";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { useSettingsQuery } from "@pm/cc-switch-source/web/settings";
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
import { agentName, installedSkillInfo, isNativeDiscoveryAgent } from "./skill-presentation";

export function OpenHandsInstalledSkills(state: SkillsInstalledPresentation) {
  const { t } = useOpenHandsTranslation();
  const { t: sourceT } = useTranslation();
  const { data: settings } = useSettingsQuery();
  const assignmentId = React.useId();
  const [filter, setFilter] = React.useState(() => parseSkillFilterState(new URLSearchParams()));
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const allSkills = React.useMemo(() => state.skills.map((skill) => installedSkillInfo(skill, state.appIds)), [state.skills, state.appIds]);
  const groups = buildSkillFacetGroups(allSkills, filter, {
    state: "SKILLS_PM$ASSIGNMENT_DISCOVERY", source: "SKILLS_PM$SOURCE", agent: "SKILLS_PM$AGENT",
    assigned: "SKILLS_PM$SAVED_ASSIGNED", unassigned: "SKILLS_PM$SAVED_UNASSIGNED",
    native: "SKILLS_PM$NATIVE_DISCOVERED", local: "SKILLS_PM$LOCAL_SOURCE",
  });
  const visibleSkills = applySkillFilters(allSkills, filter);
  const activeCount = countActiveFilters(filter);
  const selected = state.skills.find((skill) => skill.id === selectedId);
  const selectedInfo = allSkills.find((skill) => skill.id === selectedId);
  const toggleFacet = (id: SkillFacetGroupId, value: string) => setFilter((current) => toggleSkillFilterValue(current, id, value));
  const clearFacets = () => setFilter((current) => clearSkillFilterFacets(current));
  return <div data-testid="skills-page" className="oh-skills-cards flex min-h-0 flex-1 flex-col gap-4">
    <div className="oh-skills-notice" role="note">
      <p className="oh-skills-state-note">{t("SKILLS_PM$STATE_NOTE")}</p>
      <details>
        <summary>{t("SKILLS_PM$NATIVE_WARNING")}</summary>
        <p>{sourceT("skillsPage.piHelp")}</p>
        <p>{sourceT("appMatrix.ompDiscovery.help")}</p>
        <p>{t("SKILLS_PM$NON_ISOLATION")}</p>
        <p>{t("SKILLS_PM$RELOAD_NOTE")}</p>
      </details>
    </div>
    {settings?.skillStorageLocation === "unified" ? <div className="oh-skills-notice oh-skills-warning" role="note">{sourceT("skills.storageSheet.unifiedWarning")}</div> : null}
    {state.updatesOnly ? <div className="oh-skills-result-bar oh-skills-notice">
      <span>{t("SKILLS_PM$SHOWING_UPDATES")}</span>
      <Button variant="quiet" onClick={state.onClearUpdateFilter}>{t("SKILLS_PM$SHOW_ALL")}</Button>
    </div> : null}
    <SkillsToolbar search={filter.query} onSearchChange={(query) => setFilter((current) => ({ ...current, query }))}
      activeFilterCount={activeCount} onOpenFilters={() => setFiltersOpen(true)} />
    <div className="oh-skills-library">
      <SkillFacetRail groups={groups} onToggle={toggleFacet} className="oh-skills-facet-rail hidden w-52 shrink-0 self-start md:flex" />
      <section className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="oh-skills-result-bar">
          <span data-testid="skills-result-summary" role="status">{t("SETTINGS$SKILLS_RESULT_COUNT", { count: visibleSkills.length })}</span>
          {activeCount ? <button type="button" onClick={clearFacets} className="cursor-pointer underline">{t("SETTINGS$SKILLS_CLEAR_FILTERS")}</button> : null}
          <Button variant="quiet" disabled={state.busy || state.refreshing} onClick={state.onRefresh}>{t("SKILLS_PM$REFRESH_OBSERVATION")}</Button>
        </div>
        {visibleSkills.length ? <div className={extensionModuleCardGridContainerClassName}><div className={extensionModuleCardGridClassName}>
          {visibleSkills.map((skill) => <div key={skill.id} id={`sk-row-${skill.id}`} tabIndex={-1}>
            <SkillCard skill={skill} onOpen={() => setSelectedId(skill.id)}
              summary={<div className="oh-skill-card-status">
                <div className="oh-skill-status-badges">
                  <span className="oh-skill-state-badge">{t("SKILLS_PM$LIBRARY_STORED")}</span>
                  {state.updates[skill.id] ? <span className="oh-skill-state-badge oh-skill-update-badge">{t("SKILLS_PM$UPDATE_AVAILABLE")}</span> : null}
                </div>
                {!skill.source ? <span>{t("SKILLS_PM$SOURCE_UNKNOWN")}</span> : null}
                <span><strong>{t("SKILLS_PM$SAVED_ASSIGNMENTS")}: </strong>{skill.assignedAgents.map(agentName).join(", ") || t("SKILLS_PM$NONE")}</span>
                <div className="oh-skill-status-badges" data-testid={`skill-native-discovery-${skill.id}`}>
                  {skill.nativeDiscoveredAgents.length ? skill.nativeDiscoveredAgents.map((app) =>
                    <span key={app} className="oh-skill-state-badge" data-agent={app}>{t("SKILLS_PM$NATIVE_BADGE", { agent: agentName(app) })}</span>,
                  ) : <span>{t("SKILLS_PM$NO_NATIVE_OBSERVATION")}</span>}
                </div>
                <span className="oh-skill-runtime-state">{t("SKILLS_PM$RUNTIME_UNVERIFIED")}</span>
              </div>}
              action={<Button variant="quiet" size="compact" onClick={() => setSelectedId(skill.id)}>{t("SKILLS_PM$CONFIGURE")}</Button>}
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
      <Button variant="neutral" disabled={state.busy} onClick={() => { setSelectedId(null); state.onOpenDirectory(selected); }}>{t("SKILLS_PM$BROWSE_FILES")}</Button>
      {selected.readmeUrl || selected.repoOwner && selected.repoName ? <Button variant="quiet" disabled={state.busy} onClick={() => state.onOpenDocs(selected)}>{t("SKILLS_PM$OPEN_SOURCE")}</Button> : null}
      {state.updates[selected.id] ? <Button variant="neutral" disabled={state.busy} onClick={() => state.onUpdate(selected.id)}>{sourceT("skills.update")}</Button> : null}
      <Button variant="quiet" disabled={state.busy} onClick={() => { setSelectedId(null); state.onUninstall(selected.id); }}>{t("SKILLS_PM$UNINSTALL_BACKUP")}</Button>
    </>}>
      <div className="oh-skill-status-badges">
        <span className="oh-skill-state-badge">{t("SKILLS_PM$LIBRARY_STORED")}</span>
        <span className="oh-skill-state-badge">{t("SKILLS_PM$RUNTIME_UNVERIFIED")}</span>
      </div>
      <dl className="oh-skill-metadata">
        <dt>{t("SKILLS_PM$SOURCE")}</dt><dd>{selectedInfo.source || t("SKILLS_PM$SOURCE_UNKNOWN")}</dd>
        <dt>{t("SKILLS_PM$DIRECTORY")}</dt><dd><code>{selected.directory}</code></dd>
        {selected.repoBranch ? <><dt>{t("SKILLS_PM$BRANCH")}</dt><dd><code>{selected.repoBranch}</code></dd></> : null}
        <dt>{t("SKILLS_PM$IDENTIFIER")}</dt><dd><code>{selected.id}</code></dd>
        {selected.contentHash ? <><dt>{t("SKILLS_PM$CONTENT_HASH")}</dt><dd><code>{selected.contentHash}</code></dd></> : null}
      </dl>
      <p className="oh-skills-detail-note">{t("SKILLS_PM$DETAIL_NOTE")}</p>
      <fieldset className="oh-skill-assignments"><legend>{t("SKILLS_PM$ASSIGNMENTS_TITLE")}</legend>
        {state.appIds.map((app) => {
          const bound = isTargetAvailable(app);
          const native = isNativeDiscoveryAgent(app);
          const failure = state.failures[`${selected.id}\u0000${app}`];
          const enabled = bound && Boolean(selected.apps[app]);
          const statusKey = !bound ? "SKILLS_PM$TARGET_UNBOUND" : native
            ? enabled ? "SKILLS_PM$OBSERVED" : "SKILLS_PM$NOT_OBSERVED"
            : enabled ? "SKILLS_PM$SAVED_ON" : "SKILLS_PM$SAVED_OFF";
          const reasonKey = !bound ? "SKILLS_PM$UNBOUND_REASON" : native
            ? enabled ? "SKILLS_PM$NATIVE_FOUND" : "SKILLS_PM$NATIVE_NOT_FOUND"
            : enabled ? "SKILLS_PM$SAVED_ENABLED" : "SKILLS_PM$SAVED_DISABLED";
          const reasonId = `${assignmentId}-${app}`;
          return <div key={app} className="oh-skill-assignment" data-target-bound={bound}>
            <div className="oh-skill-assignment-heading">
              <label><input type="checkbox" checked={enabled} disabled={!bound || state.busy}
                aria-describedby={reasonId}
                onChange={(event) => state.onToggle(selected.id, app, event.target.checked)} /> <span>{agentName(app)}</span></label>
              <span className="oh-skill-state-badge">{t(statusKey)}</span>
            </div>
            <p id={reasonId} className="oh-skill-assignment-reason">{t(reasonKey)}</p>
            {failure ? <div role="alert" className="oh-skill-error">{failure.error} <Button variant="quiet" disabled={!bound || state.busy} onClick={() => state.onToggle(selected.id, app, failure.desired)}>{sourceT("common.retry")}</Button></div> : null}
          </div>;
        })}
      </fieldset>
      <p className="oh-skills-detail-note">{t("SKILLS_PM$NON_ISOLATION")}</p>
      <p className="oh-skills-detail-note">{t("SKILLS_PM$RELOAD_NOTE")}</p>
      <Button variant="quiet" disabled={state.busy} onClick={() => { setSelectedId(null); state.onOpenStorage(); }}>{t("SKILLS_PM$STORAGE_SYNC")}</Button>
    </SkillDetailModal> : null}
  </div>;
}
