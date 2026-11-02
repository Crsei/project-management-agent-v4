import { validateNativeTemplateArguments } from '../../../../../../packages/contracts/src/automation-native-template-arguments.ts';
import { pmAutomationTemplateIds } from '../../../../../../packages/contracts/src/automation-pm.ts';
import { pmAutomationHandlers } from './pm-runtime.ts';
import { contentHandlers } from './content.ts';
import { githubAgentHandlers } from './github-agent.ts';
import { githubMaintenanceHandlers } from './github-maintenance.ts';
import type { NativeTemplateHandler, NativeTemplateId } from './ports.ts';

export const nativeTemplateIds: readonly NativeTemplateId[] = ['github-issue-to-pr', 'github-issue-triage', 'github-pr-reviewer', 'github-delivery-watchdog', 'github-stale-ci-pr-closer', 'news-digest', 'github-agents-md-maintainer', 'gitlab-issue-to-mr', ...pmAutomationTemplateIds];
const handlers: Partial<Record<NativeTemplateId, NativeTemplateHandler>> = { ...githubAgentHandlers, ...githubMaintenanceHandlers, ...contentHandlers, ...pmAutomationHandlers };
export function resolveNativeTemplateHandler(id: NativeTemplateId, arguments_: Readonly<Record<string, unknown>>): NativeTemplateHandler {
  const issues = validateNativeTemplateArguments(id, arguments_);
  if (issues.length) throw new Error(issues.map(issue => `${issue.path}: ${issue.message}`).join('\n'));
  const handler = handlers[id];
  if (!handler) throw new Error(`Native template handler ${id} is not registered in this server build.`);
  return handler;
}
export function hasNativeTemplateHandler(id: NativeTemplateId): boolean { return typeof handlers[id] === 'function'; }
