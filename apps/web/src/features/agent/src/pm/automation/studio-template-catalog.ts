import { automationTemplateSource, automationTemplateTags, automationTemplateTriggers } from "../../../../../../../../packages/automation-resources/catalog.ts";
import type { AutomationCatalogTemplate } from "../../../../../../../../packages/contracts/src/automation-catalog.ts";

export type StudioTemplateFilters = { query: string; source: string; category: string; integration: string; trigger: string };
/** Pure browsing: selection/filtering never creates a session, saves a definition or dispatches a run. */
export function filterStudioTemplates(catalog: readonly AutomationCatalogTemplate[], filters: StudioTemplateFilters): AutomationCatalogTemplate[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return catalog.filter(template => (!query || [template.id, template.scenario ?? "", template.name, template.description, template.category, automationTemplateSource(template), ...automationTemplateTags(template)].join(" ").toLocaleLowerCase().includes(query))
    && (!filters.source || automationTemplateSource(template) === filters.source)
    && (!filters.category || template.category === filters.category)
    && (!filters.integration || automationTemplateTags(template).includes(filters.integration))
    && (!filters.trigger || automationTemplateTriggers(template).includes(filters.trigger)));
}
