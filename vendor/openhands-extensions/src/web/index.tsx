import { useEffect, useLayoutEffect } from "react";
import { OpenHandsMcpPage } from "@pm/openhands-source/routes/mcp";
import { OpenHandsSkillsPage } from "@pm/openhands-source/routes/skills-settings";
import { ExtensionsCompactNavigation } from "@pm/openhands-source/components/features/skills/extensions-navigation";
import { webPlatform } from "./bridge";
import { useOpenHandsTranslation } from "./i18n";
import "./management.css";

export interface OpenHandsExtensionSurfaceProps {
  view: "mcp" | "skills";
  onInteractionBlockedChange?(blocked: boolean): void;
}

/** Presentation only: the surrounding CC Switch host owns all providers,
 * authorized transport, portals, event leases and source lifecycle hooks. */
export function OpenHandsExtensionSurface({ view, onInteractionBlockedChange }: OpenHandsExtensionSurfaceProps) {
  const { t } = useOpenHandsTranslation();
  const platform = webPlatform();
  const noNativeSkills = view === "skills" && !platform.context.apps.length;
  useLayoutEffect(() => {
    platform.portal.classList.add("openhands-extensions");
    return () => { platform.portal.classList.remove("openhands-extensions"); };
  }, [platform]);
  useEffect(() => () => { onInteractionBlockedChange?.(false); }, [onInteractionBlockedChange]);
  return <section className="openhands-extensions oh-extension-surface" data-testid="openhands-extension-surface" data-view={view}>
    <div className="oh-extension-frame">
      <div className="oh-extension-main">
        <div className="oh-extension-tools"><ExtensionsCompactNavigation /></div>
        <div className="oh-extension-route">
          {noNativeSkills ? <div className="oh-module-empty" role="note"><h2>{t("PM$NATIVE_SKILLS_UNAVAILABLE", { defaultValue: "No authorized native Skills target" })}</h2><p>{t("PM$NATIVE_SKILLS_BINDING", { defaultValue: "Project-private contexts manage MCP definitions only. Choose an explicitly bound native context to discover, install, update, restore or migrate Skills." })}</p></div> : view === "mcp" ? <OpenHandsMcpPage onInteractionBlockedChange={onInteractionBlockedChange} /> : <OpenHandsSkillsPage onInteractionBlockedChange={onInteractionBlockedChange} />}
        </div>
      </div>
    </div>
  </section>;
}
