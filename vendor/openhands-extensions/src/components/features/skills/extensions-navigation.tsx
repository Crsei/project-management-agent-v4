import type { ReactElement } from "react";
import { Blocks, Bot, BookOpen, Server } from "lucide-react";
import { useLocation } from "react-router-dom";
import { CompactSectionNavigation } from "@pm/openhands-source/components/shared/compact-section-navigation";
import { NavigationLink } from "@pm/openhands-source/components/shared/navigation-link";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { cn } from "@pm/openhands-source/utils/utils";

interface ExtensionNavItem {
  to?: string;
  label: string;
  icon: ReactElement;
  end?: boolean;
  unavailable?: boolean;
}

// Only real host routes are navigable. There is no OpenHands cloud settings,
// backend selection or outbound OAuth runtime behind these links.
// MCP and Skills already live in the host settings navigation. This surface
// exposes only related settings rather than a competing extension sidebar.
export const EXTENSIONS_NAV_ITEMS: ExtensionNavItem[] = [
  { to: "/agent/settings/mcp-servers", label: "MCP Servers", icon: <Server size={16} aria-hidden />, end: true },
  { to: "/agent/settings/skills", label: "Skills", icon: <BookOpen size={16} aria-hidden />, end: true },
  { label: "Plugins", icon: <Blocks size={16} aria-hidden />, unavailable: true },
  { to: "/agent/settings/providers", label: "Agents", icon: <Bot size={16} aria-hidden />, end: true },
];

export function ExtensionsNavigation() {
  const { t } = useOpenHandsTranslation();
  return <aside data-testid="extensions-navbar-desktop" className="oh-extensions-navigation">
    <nav aria-label={t("PM$RELATED_SETTINGS")}><ExtensionsNavigationLinks /></nav>
  </aside>;
}

function ExtensionsNavigationLinks() {
  const { t } = useOpenHandsTranslation();
  const location = useLocation();
  const pluginReason = t("PM$PLUGINS_UNAVAILABLE", { defaultValue: "Plugins unavailable: this host has no Plugin installation backend or runtime." });
  return <div className="oh-extension-links">{EXTENSIONS_NAV_ITEMS.filter(item => item.unavailable || item.to === "/agent/settings/providers").map(item => item.unavailable ?
    <div key={item.label} className="oh-navigation-unavailable"><span className="oh-navigation-row" aria-disabled="true">{item.icon}<span>{item.label}</span><span className="oh-navigation-badge">{t("PM$UNAVAILABLE", { defaultValue: "Unavailable" })}</span></span><small>{pluginReason}</small></div> :
    <div key={item.to}><NavigationLink to={`${item.to}${location.search}`} end={item.end} data-testid="sidebar-extensions-agents" className={({ isActive }) => cn("oh-navigation-row", isActive && "oh-navigation-active")}>{item.icon}<span>{t("PM$AGENTS_SETTINGS")}</span></NavigationLink><p className="oh-nav-explanation">{t("PM$AGENTS_LINK")}</p></div>
  )}</div>;
}

export function ExtensionsCompactNavigation() {
  const { t } = useOpenHandsTranslation();
  return <CompactSectionNavigation label={t("PM$RELATED_SETTINGS_SUMMARY")} testId="extensions-compact-navigation"><ExtensionsNavigationLinks /></CompactSectionNavigation>;
}
