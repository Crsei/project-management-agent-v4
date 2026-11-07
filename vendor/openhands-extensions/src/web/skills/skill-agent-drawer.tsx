import React from "react";
import { useTranslation } from "react-i18next";
import {
  Button, Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle,
  type InstalledSkill, type SkillsInstalledPresentation,
} from "@pm/cc-switch-ui";
import { isTargetAvailable } from "@pm/openhands-source/web/bridge";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { SkillIconBadge } from "@pm/openhands-source/components/features/skills/skill-icon-badge";
import { agentName, isNativeDiscoveryAgent } from "./skill-presentation";

/** Adapted from mcp-skill-page SkillAgentDrawer: writes are immediate, not simulated drafts. */
export function SkillAgentDrawer({ skill, state, onClose }: {
  skill: InstalledSkill;
  state: SkillsInstalledPresentation;
  onClose: () => void;
}) {
  const { t } = useOpenHandsTranslation();
  const { t: sourceT } = useTranslation();
  const assignmentId = React.useId();
  const assigned = state.appIds.filter((app) => isTargetAvailable(app) && !isNativeDiscoveryAgent(app) && skill.apps[app]);
  const observed = state.appIds.filter((app) => isTargetAvailable(app) && isNativeDiscoveryAgent(app) && skill.apps[app]);
  return <Sheet open onOpenChange={(open) => { if (!open && !state.busy) onClose(); }}>
    <SheetContent width={440} closeLabel={t("BUTTON$CLOSE")} data-testid="skill-agent-drawer" onEscapeKeyDown={(event) => { if (state.busy) event.preventDefault(); }}>
      <SheetHeader>
        <div className="oh-skill-drawer-heading"><SkillIconBadge skillName={skill.name} /><div>
          <SheetTitle>{skill.name}</SheetTitle>
          <SheetDescription>{skill.repoOwner && skill.repoName ? `${skill.repoOwner}/${skill.repoName}` : t("SKILLS_PM$SOURCE_UNKNOWN")}</SheetDescription>
        </div></div>
      </SheetHeader>
      <SheetBody className="oh-skill-drawer-body">
        <div className="oh-skill-drawer-stats">
          <div><span>{t("SKILLS_PM$SAVED_ASSIGNMENTS")}</span><strong>{assigned.length}</strong></div>
          <div><span>{t("SKILLS_PM$NATIVE_DISCOVERED")}</span><strong>{observed.length}</strong></div>
          <div><span>{t("SKILLS_PM$AGENT")}</span><strong>{state.appIds.filter(isTargetAvailable).length}/{state.appIds.length}</strong></div>
        </div>
        <fieldset className="oh-skill-assignments"><legend>{t("SKILLS_PM$ASSIGNMENTS_TITLE")}</legend>
          {state.appIds.map((app) => {
            const bound = isTargetAvailable(app);
            const native = isNativeDiscoveryAgent(app);
            const failure = state.failures[`${skill.id}\u0000${app}`];
            const enabled = bound && Boolean(skill.apps[app]);
            const statusKey = !bound ? "SKILLS_PM$TARGET_UNBOUND" : native
              ? enabled ? "SKILLS_PM$OBSERVED" : "SKILLS_PM$NOT_OBSERVED"
              : enabled ? "SKILLS_PM$SAVED_ON" : "SKILLS_PM$SAVED_OFF";
            const reasonKey = !bound ? "SKILLS_PM$UNBOUND_REASON" : native
              ? enabled ? "SKILLS_PM$NATIVE_FOUND" : "SKILLS_PM$NATIVE_NOT_FOUND"
              : enabled ? "SKILLS_PM$SAVED_ENABLED" : "SKILLS_PM$SAVED_DISABLED";
            const reasonId = `${assignmentId}-${app}`;
            return <div key={app} className="oh-skill-assignment" data-target-bound={bound} data-testid={`skill-agent-row-${app}`}>
              <div className="oh-skill-assignment-heading">
                <label><span className="oh-skill-agent-avatar" aria-hidden="true">{agentName(app).slice(0, 2).toUpperCase()}</span><span>{agentName(app)}</span>
                  <input type="checkbox" checked={enabled} disabled={!bound || state.busy} aria-describedby={reasonId}
                    onChange={(event) => state.onToggle(skill.id, app, event.target.checked)} /></label>
                <span className="oh-skill-state-badge">{t(statusKey)}</span>
              </div>
              <p id={reasonId} className="oh-skill-assignment-reason">{t(reasonKey)}</p>
              {failure ? <div role="alert" className="oh-skill-error">{failure.error} <Button variant="quiet" disabled={!bound || state.busy} onClick={() => state.onToggle(skill.id, app, failure.desired)}>{sourceT("common.retry")}</Button></div> : null}
            </div>;
          })}
        </fieldset>
        <Button variant="quiet" disabled={state.busy} onClick={() => { onClose(); state.onOpenStorage(); }}>{t("SKILLS_PM$STORAGE_SYNC")}</Button>
      </SheetBody>
    </SheetContent>
  </Sheet>;
}
