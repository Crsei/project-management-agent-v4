/** OpenHands MIT production catalog, pinned with licenses and file hashes in vendor/openhands-automations. */
import type { RecommendedAutomation, AutomationFormField, AutomationSetup, AutomationTriggerForm } from '../../../vendor/openhands-automations/index.d.ts';
import type { PmAutomationTemplateId } from './automation-pm.ts';
import { pmAutomationCatalog, pmAutomationRecommendedIds } from './automation-pm-catalog.ts';
import sourceInterface from '../../../vendor/openhands-automations/interface.json' with { type: 'json' };
import template0 from '../../../vendor/openhands-automations/catalog/github-pr-reviewer/manifest.json' with { type: 'json' };
import template1 from '../../../vendor/openhands-automations/catalog/custom-automation/manifest.json' with { type: 'json' };
import template2 from '../../../vendor/openhands-automations/catalog/github-repo-monitor/manifest.json' with { type: 'json' };
import template3 from '../../../vendor/openhands-automations/catalog/github-issue-to-pr/manifest.json' with { type: 'json' };
import template4 from '../../../vendor/openhands-automations/catalog/slack-standup-digest/manifest.json' with { type: 'json' };
import template5 from '../../../vendor/openhands-automations/catalog/slack-channel-monitor/manifest.json' with { type: 'json' };
import template6 from '../../../vendor/openhands-automations/catalog/linear-triage-assistant/manifest.json' with { type: 'json' };
import template7 from '../../../vendor/openhands-automations/catalog/linear-issue-to-github-pr/manifest.json' with { type: 'json' };
import template8 from '../../../vendor/openhands-automations/catalog/gitlab-issue-to-mr/manifest.json' with { type: 'json' };
import template9 from '../../../vendor/openhands-automations/catalog/linear-issue-to-gitlab-mr/manifest.json' with { type: 'json' };
import template10 from '../../../vendor/openhands-automations/catalog/linear-issue-to-bitbucket-pr/manifest.json' with { type: 'json' };
import template11 from '../../../vendor/openhands-automations/catalog/jira-issue-to-pr/manifest.json' with { type: 'json' };
import template12 from '../../../vendor/openhands-automations/catalog/qa-changes/manifest.json' with { type: 'json' };
import template13 from '../../../vendor/openhands-automations/catalog/jira-issue-to-gitlab-mr/manifest.json' with { type: 'json' };
import template14 from '../../../vendor/openhands-automations/catalog/research-brief-writer/manifest.json' with { type: 'json' };
import template15 from '../../../vendor/openhands-automations/catalog/jira-issue-to-bitbucket-pr/manifest.json' with { type: 'json' };
import template16 from '../../../vendor/openhands-automations/catalog/github-agents-md-maintainer/manifest.json' with { type: 'json' };
import template17 from '../../../vendor/openhands-automations/catalog/github-delivery-watchdog/manifest.json' with { type: 'json' };
import template18 from '../../../vendor/openhands-automations/catalog/github-issue-triage/manifest.json' with { type: 'json' };
import template19 from '../../../vendor/openhands-automations/catalog/upstream-fork-sync/manifest.json' with { type: 'json' };
import template20 from '../../../vendor/openhands-automations/catalog/incident-retrospective-drafter/manifest.json' with { type: 'json' };
import template21 from '../../../vendor/openhands-automations/catalog/news-digest/manifest.json' with { type: 'json' };
import template22 from '../../../vendor/openhands-automations/catalog/github-stale-ci-pr-closer/manifest.json' with { type: 'json' };

/** Manual triggers and native handlers are host-owned additions, never mutations of the vendor schema. */
export type AutomationCatalogTemplate = Omit<RecommendedAutomation, 'setup' | 'triggers'> & {
  source?: 'openhands' | 'pm'; sourceCategory?: string; maturity?: 'stable' | 'beta'; recommended?: boolean; scenario?: string;
  triggers?: ('manual' | 'cron' | 'event')[];
  setup?: Omit<AutomationSetup, 'form'> & {
    native?: { templateId: PmAutomationTemplateId };
    form: Omit<AutomationSetup['form'], 'triggers'> & { triggers?: AutomationTriggerForm & { manual?: Record<string, AutomationFormField> } };
  };
};
export type AutomationCatalogField = AutomationFormField;
// The source QA filter negates the object before `.draft` lookup in standard
// JMESPath. Preserve the pinned source; correct the intended non-draft gate here.
const qaChangesTemplate = { ...template12, setup: { ...template12.setup, filter: "!(pull_request.draft) && !icontains(pull_request.body, 'QA Agent') && glob(repository.full_name, '{{form.repository}}')" } };
export const automationCatalog = [...[template0, template1, template2, template3, template4, template5, template6, template7, template8, template9, template10, template11, qaChangesTemplate, template13, template14, template15, template16, template17, template18, template19, template20, template21, template22] as readonly AutomationCatalogTemplate[], ...pmAutomationCatalog];
export const automationCatalogById = new Map(automationCatalog.map(template => [template.id, template]));
export const automationCatalogSource = { commit: 'b4a3f45a28f6b6c387a8deb3dc7c18b4393c59c1', agentCanvasVersion: '1.34.0', extensionsVersion: '0.36.0', license: 'MIT' } as const;
export const automationFeaturedIds: readonly string[] = [...sourceInterface.featuredAutomationIds, ...pmAutomationRecommendedIds];
export function automationTemplateSource(template: AutomationCatalogTemplate): 'openhands' | 'pm' { return template.source ?? 'openhands'; }
export function automationTemplateMaturity(template: AutomationCatalogTemplate): 'stable' | 'beta' { return template.maturity ?? (sourceInterface.featuredAutomationIds.includes(template.id) ? 'stable' : 'beta'); }
export function automationTemplateRecommended(template: AutomationCatalogTemplate): boolean { return template.recommended ?? sourceInterface.featuredAutomationIds.includes(template.id); }
export function automationTemplateTags(template: AutomationCatalogTemplate): string[] {
  const tags = Object.keys(template.requires.integrations);
  for (const field of Object.values(template.setup?.form.args ?? {})) if (field.type === 'repo-picker' && field.provider && !tags.includes(field.provider)) tags.push(field.provider);
  return tags;
}
export function automationTemplateTriggers(template: AutomationCatalogTemplate): string[] { return template.setup?.form.triggers ? Object.keys(template.setup.form.triggers) : template.triggers ?? []; }
export function automationTemplateLaunchPrompt(template: AutomationCatalogTemplate): string {
  return [
    `Help configure the ${template.name} automation (${template.id}) in this PM project.`,
    template.description,
    `Template form and prerequisites:\n${JSON.stringify({ form: template.setup?.form, requires: template.requires }, null, 2)}`,
    'Use the native PM automation editor and current actor authorization. Ask for missing values and return a proposed configuration for explicit review. The editor supports prompt, isolated Python, and registered native template actions; do not use OpenHands deployment commands, global credentials, or source service endpoints. Do not create, enable, execute, or submit anything automatically.',
  ].join('\n\n');
}
export async function automationTemplateBundle(templateId: string): Promise<Record<string, string>> {
  switch (templateId) {
    case 'github-pr-reviewer': return (await import('../../../vendor/openhands-automations/bundles/github-pr-reviewer/files.json', { with: { type: 'json' } })).default;
    case 'github-issue-to-pr': return (await import('../../../vendor/openhands-automations/bundles/github-issue-to-pr/files.json', { with: { type: 'json' } })).default;
    case 'gitlab-issue-to-mr': return (await import('../../../vendor/openhands-automations/bundles/gitlab-issue-to-mr/files.json', { with: { type: 'json' } })).default;
    case 'github-agents-md-maintainer': return (await import('../../../vendor/openhands-automations/bundles/github-agents-md-maintainer/files.json', { with: { type: 'json' } })).default;
    case 'github-delivery-watchdog': return (await import('../../../vendor/openhands-automations/bundles/github-delivery-watchdog/files.json', { with: { type: 'json' } })).default;
    case 'github-issue-triage': return (await import('../../../vendor/openhands-automations/bundles/github-issue-triage/files.json', { with: { type: 'json' } })).default;
    case 'news-digest': return (await import('../../../vendor/openhands-automations/bundles/news-digest/files.json', { with: { type: 'json' } })).default;
    case 'github-stale-ci-pr-closer': return (await import('../../../vendor/openhands-automations/bundles/github-stale-ci-pr-closer/files.json', { with: { type: 'json' } })).default;
    default: throw new Error('This catalog template does not include a production script bundle');
  }
}
