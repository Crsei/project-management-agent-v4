import React from "react";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";

type SkillsView = "catalog" | "config";

export function UnboundSkillsPage({ onBind }: { onBind: () => void }) {
  const { t } = useOpenHandsTranslation();
  const [view, setView] = React.useState<SkillsView>("catalog");
  const id = React.useId();
  const tabs: SkillsView[] = ["catalog", "config"];

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    let next: SkillsView;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowLeft":
        next = view === "catalog" ? "config" : "catalog";
        break;
      case "Home":
        next = "catalog";
        break;
      case "End":
        next = "config";
        break;
      default:
        return;
    }
    event.preventDefault();
    setView(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();
  }

  return (
    <div className="oh-skills-page oh-skills-unbound" data-testid="skills-page">
      <header className="oh-skills-unbound-header">
        <div>
          <h2>Skills</h2>
          <p>{t("SKILLS_PM$UNBOUND_DESCRIPTION")}</p>
        </div>
        <button type="button" className="oh-brand-button oh-brand-button-secondary" data-testid="skills-add-skill-button" onClick={onBind}>
          {t("SKILLS_PM$UNBOUND_INSTALL")}
        </button>
      </header>

      <div className="oh-skills-unbound-tabs" role="tablist" aria-label={t("SKILLS_PM$UNBOUND_VIEWS")} onKeyDown={handleTabKeyDown}>
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`${id}-${tab}-tab`}
            aria-controls={`${id}-${tab}-panel`}
            aria-selected={view === tab}
            tabIndex={view === tab ? 0 : -1}
            data-view={tab}
            data-testid={tab === "catalog" ? "skills-tab-catalog" : "skills-tab-matrix"}
            onClick={() => setView(tab)}
          >
            {t(tab === "catalog" ? "SKILLS_PM$CATALOG" : "SKILLS_PM$CONFIG")}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <section
          key={tab}
          className="oh-skills-unbound-panel oh-module-empty"
          role="tabpanel"
          id={`${id}-${tab}-panel`}
          aria-labelledby={`${id}-${tab}-tab`}
          tabIndex={0}
          hidden={view !== tab}
          data-testid={tab === "catalog" ? "skills-unbound-catalog" : "skills-unbound-config"}
        >
          <h3>{t(tab === "catalog" ? "SKILLS_PM$UNBOUND_CATALOG_TITLE" : "SKILLS_PM$UNBOUND_CONFIG_TITLE")}</h3>
          <p>{t(tab === "catalog" ? "SKILLS_PM$UNBOUND_CATALOG_DESCRIPTION" : "SKILLS_PM$UNBOUND_CONFIG_DESCRIPTION")}</p>
          <button type="button" className="oh-brand-button oh-brand-button-primary" onClick={onBind}>
            {t("SKILLS_PM$UNBOUND_BIND")}
          </button>
        </section>
      ))}
    </div>
  );
}
