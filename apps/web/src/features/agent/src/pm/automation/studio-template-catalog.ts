import { automationTemplateTags, automationTemplateTriggers } from "../../../../../../../../packages/automation-resources/catalog.ts";
import type { AutomationCatalogTemplate } from "../../../../../../../../packages/contracts/src/automation-catalog.ts";

export type StudioTemplateFilters = { query: string; category: string; trigger: string };
/** Pure browsing: selection/filtering never creates a session, saves a definition or dispatches a run. */
export function filterStudioTemplates(catalog: readonly AutomationCatalogTemplate[], filters: StudioTemplateFilters): AutomationCatalogTemplate[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return catalog.filter(template => (!query || [template.id, template.scenario ?? "", template.name, template.description, template.category, ...automationTemplateTags(template)].join(" ").toLocaleLowerCase().includes(query))
    && (!filters.category || template.category === filters.category)
    && (!filters.trigger || automationTemplateTriggers(template).includes(filters.trigger)));
}
