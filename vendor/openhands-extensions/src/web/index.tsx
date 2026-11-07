import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { i18n } from "@pm/cc-switch-ui";
import { OpenHandsMcpPage } from "@pm/openhands-source/routes/mcp";
import { OpenHandsSkillsPage } from "@pm/openhands-source/routes/skills-settings";
import { webPlatform } from "./bridge";
import { useOpenHandsTranslation } from "./i18n";
import { UnboundMcpPage } from "./mcp/unbound-mcp-page";
import { UnboundSkillsPage } from "./skills/unbound-skills-page";
import "./management.css";
import "./shared/shared.css";

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
  return <ExtensionFrame view={view}>
    {noNativeSkills ? <div className="oh-module-empty" role="note"><h2>{t("PM$NATIVE_SKILLS_UNAVAILABLE")}</h2><p>{t("PM$NATIVE_SKILLS_BINDING")}</p></div> : view === "mcp" ? <OpenHandsMcpPage onInteractionBlockedChange={onInteractionBlockedChange} /> : <OpenHandsSkillsPage onInteractionBlockedChange={onInteractionBlockedChange} />}
  </ExtensionFrame>;
}

/** Catalog/setup presentation for installations without a supported Provider.
 * No management platform, event stream or native target is created here. */
export function OpenHandsProviderSetupSurface({ view, locale, onConfigureProvider }: {
  view: OpenHandsExtensionSurfaceProps["view"];
  locale: string;
  onConfigureProvider: () => void;
}) {
  useLayoutEffect(() => { void i18n.changeLanguage(locale.startsWith("zh") ? "zh" : "en"); }, [locale]);
  return <div className="cc-switch-web">
    <ExtensionFrame view={view}>
      {view === "mcp" ? <UnboundMcpPage onBind={onConfigureProvider} /> : <UnboundSkillsPage onBind={onConfigureProvider} />}
    </ExtensionFrame>
  </div>;
}

function ExtensionFrame({ view, children }: { view: OpenHandsExtensionSurfaceProps["view"]; children: ReactNode }) {
  return <section className="openhands-extensions oh-extension-surface" data-testid="openhands-extension-surface" data-view={view}>
    <div className="oh-extension-frame">
      <div className="oh-extension-main">
        <div className="oh-extension-route">{children}</div>
      </div>
    </div>
  </section>;
}
