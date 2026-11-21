/** PM-native automation catalog. External OpenHands template sources are not shipped. */
import type { AutomationCatalogTemplate } from '../contracts/src/automation-catalog.ts';
import { pmAutomationCatalog } from './pm-catalog.ts';

export const automationCatalog = pmAutomationCatalog;
export const automationCatalogById = new Map(automationCatalog.map(template => [template.id, template]));
export function automationTemplateSource(_template: AutomationCatalogTemplate): 'pm' { return 'pm'; }
export function automationTemplateMaturity(template: AutomationCatalogTemplate): 'stable' | 'beta' { return template.maturity ?? 'stable'; }
export function automationTemplateRecommended(template: AutomationCatalogTemplate): boolean { return template.recommended ?? false; }
export function automationTemplateTags(template: AutomationCatalogTemplate): string[] {
  const tags: string[] = [];
  for (const field of Object.values(template.setup?.form.args ?? {})) if (field.type === 'repo-picker' && field.provider && !tags.includes(field.provider)) tags.push(field.provider);
  return tags;
}
export function automationTemplateTriggers(template: AutomationCatalogTemplate): string[] { return template.setup?.form.triggers ? Object.keys(template.setup.form.triggers) : template.triggers ?? []; }
export function automationTemplateLaunchPrompt(template: AutomationCatalogTemplate): string {
  return [
    `Help configure the ${template.name} automation (${template.id}) in this PM project.`,
    template.description,
    `Template form and prerequisites:\n${JSON.stringify({ form: template.setup?.form, requires: template.requires }, null, 2)}`,
    'Use the native PM automation editor and current actor authorization. Ask for missing values and return a proposed configuration for explicit review. The editor supports prompt, isolated Python, and registered native template actions; do not use external deployment commands, global credentials, or source service endpoints. Do not create, enable, execute, or submit anything automatically.',
  ].join('\n\n');
}
