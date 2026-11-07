import React from "react";
import { Search, TriangleAlert, X } from "lucide-react";
import { APP_DISPLAY_NAME, type AppId, type SkillsInstalledPresentation } from "@pm/cc-switch-ui";
import { isTargetAvailable } from "@pm/openhands-source/web/bridge";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { SkillIconBadge } from "@pm/openhands-source/components/features/skills/skill-icon-badge";
import { AgentMatrixTable, MatrixBulkBar, type AgentMatrixRow } from "@pm/openhands-source/web/shared/agent-matrix-table";
import { EnumFilterDropdown } from "@pm/openhands-source/web/shared/enum-filter-dropdown";

/** Adapted from mcp-skill-page SkillAgentMatrix using the cc-switch target matrix. */
export function SkillAgentMatrix({ state, onOpen }: {
  state: SkillsInstalledPresentation;
  onOpen: (id: string) => void;
}) {
  const { t } = useOpenHandsTranslation();
  const [query, setQuery] = React.useState("");
  const [agent, setAgent] = React.useState<AppId | "all">("all");
  const [issuesOnly, setIssuesOnly] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const bulkLock = React.useRef(false);
  const agents = state.appIds.filter(isTargetAvailable);
  const hasFailure = (id: string, app: AppId) => Boolean(state.failures[`${id}\u0000${app}`]);
  const matched = state.skills.filter(skill => {
    const term = query.trim().toLocaleLowerCase();
    return (!term || [skill.name, skill.description, skill.repoOwner, skill.repoName, skill.directory].some(value => value?.toLocaleLowerCase().includes(term)))
      && (agent === "all" || (isTargetAvailable(agent) && Boolean(skill.apps[agent])))
      && (!issuesOnly || agents.some(app => hasFailure(skill.id, app)));
  });
  const visibleIds = matched.map(skill => skill.id);
  const visibleKey = JSON.stringify(visibleIds);
  React.useEffect(() => { setSelected(new Set()); }, [visibleKey]);
  const selectedSkills = matched.filter(skill => selected.has(skill.id));
  const counts = Object.fromEntries(agents.map(app => [app, state.skills.filter(skill => isTargetAvailable(app) && Boolean(skill.apps[app])).length])) as Record<string, number>;
  const assignmentCount = Object.values(counts).reduce((total, count) => total + count, 0);
  const canAssign = (app: string) => !state.busy && selectedSkills.length > 0 && isTargetAvailable(app as AppId);
  const runBulk = (app: string, enabled: boolean) => {
    if (bulkLock.current || state.busy || !isTargetAvailable(app as AppId)) return;
    const ids = selectedSkills.filter(skill => Boolean(skill.apps[app as AppId]) !== enabled).map(skill => skill.id);
    if (ids.length) void state.onBulkToggle(ids, app as AppId, enabled);
  };
  const clearAssignments = async () => {
    if (bulkLock.current || state.busy) return;
    bulkLock.current = true;
    try {
      // Each completion includes the controller's native write and reconciliation.
      for (const app of agents) {
        const ids = selectedSkills.filter(skill => skill.apps[app]).map(skill => skill.id);
        if (ids.length) await state.onBulkToggle(ids, app, false);
      }
    } finally {
      bulkLock.current = false;
    }
  };
  const rows: AgentMatrixRow[] = matched.map(skill => {
    const failure = agents.find(app => hasFailure(skill.id, app));
    return {
      id: skill.id,
      title: skill.name,
      subtitle: skill.repoOwner && skill.repoName ? `${skill.repoOwner}/${skill.repoName}` : t("SKILLS_PM$LOCAL_SOURCE"),
      icon: <SkillIconBadge skillName={skill.name} />,
      issue: failure ? `${skill.name} · ${APP_DISPLAY_NAME[failure] ?? failure}` : null,
      cells: Object.fromEntries(agents.map(app => [app, {
        supported: isTargetAvailable(app),
        enabled: isTargetAvailable(app) && Boolean(skill.apps[app]),
        syncState: hasFailure(skill.id, app) ? "error" : undefined,
        reason: !isTargetAvailable(app) ? t("SKILLS_PM$TARGET_UNBOUND") : undefined,
      }])),
    };
  });
  const agentOptions: Array<AppId | "all"> = ["all", ...agents];
  const agentLabels = { all: t("SKILLS_PM$ALL_AGENTS"), ...Object.fromEntries(agents.map(app => [app, APP_DISPLAY_NAME[app]])) } as Record<string, string>;

  return <div data-testid="skills-agent-matrix" className="oh-skills-matrix">
    <div className="oh-skills-matrix-toolbar">
      <div className="oh-skills-matrix-search">
        <Search aria-hidden />
        <input type="search" data-testid="skills-matrix-search" value={query} placeholder={t("SETTINGS$SKILLS_SEARCH_PLACEHOLDER")}
          aria-label={t("SETTINGS$SKILLS_SEARCH_PLACEHOLDER")} onChange={event => setQuery(event.target.value)} />
        {query ? <button type="button" onClick={() => setQuery("")} aria-label={t("MCP$SEARCH_CLEAR")}><X aria-hidden /></button> : null}
      </div>
      <EnumFilterDropdown testId="skills-agent-filter" value={agent} onChange={setAgent} options={agentOptions} labelByValue={agentLabels} ariaLabel={t("MCP_PM$FILTER_AGENT")} />
      <button type="button" className="oh-skills-issues-toggle" aria-pressed={issuesOnly} data-testid="skills-only-issues" onClick={() => setIssuesOnly(!issuesOnly)}>
        <TriangleAlert aria-hidden />{t("SKILLS_PM$ONLY_ISSUES")}
      </button>
    </div>
    <div className="oh-matrix-toolbar">
      <span className="oh-matrix-summary">{t("SKILLS_PM$MATRIX_SUMMARY", { count: matched.length, assignments: assignmentCount })}</span>
    </div>
    <MatrixBulkBar selectedCount={selectedSkills.length} agents={agents} canAssign={canAssign}
      onAssign={app => runBulk(app, true)}
      onClearAssignments={() => void clearAssignments()}
      onClearSelection={() => setSelected(new Set())}
      assignLabel={t("SKILLS_PM$BULK_ASSIGN")} clearLabel={t("SKILLS_PM$BULK_UNASSIGN")} clearSelectionLabel={t("SKILLS_PM$CLEAR_SELECTION")} />
    <AgentMatrixTable agents={agents} rows={rows} selected={selected} onSelectedChange={setSelected}
      onToggleCell={(id, app, enabled) => { if (!bulkLock.current && !state.busy) state.onToggle(id, app as AppId, enabled); }}
      onOpenRow={onOpen}
      agentCounts={counts}
      rowHeaderLabel={t("SKILLS_PM$SKILL_COLUMN")}
      emptyLabel={t(state.skills.length ? "SKILLS_PM$FILTER_EMPTY" : "SKILLS_PM$LIBRARY_EMPTY")} />
    {state.busy ? <p className="oh-skills-detail-note" role="status">{t("SETTINGS$SAVING")}</p> : null}
  </div>;
}
