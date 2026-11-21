import { validateNativeTemplateArguments } from '../../../../../../packages/automation-resources/native-template-arguments.ts'
import { pmAutomationTemplateIds } from '../../../../../../packages/contracts/src/automation-pm.ts';
import { pmAutomationHandlers } from './pm-runtime.ts';
import type { NativeTemplateHandler, NativeTemplateId } from './ports.ts';

export const nativeTemplateIds: readonly NativeTemplateId[] = pmAutomationTemplateIds;
const handlers: Partial<Record<NativeTemplateId, NativeTemplateHandler>> = { ...pmAutomationHandlers };
export function resolveNativeTemplateHandler(id: NativeTemplateId, arguments_: Readonly<Record<string, unknown>>): NativeTemplateHandler {
  const issues = validateNativeTemplateArguments(id, arguments_);
  if (issues.length) throw new Error(issues.map(issue => `${issue.path}: ${issue.message}`).join('\n'));
  const handler = handlers[id];
  if (!handler) throw new Error(`Native template handler ${id} is not registered in this server build.`);
  return handler;
}
export function hasNativeTemplateHandler(id: NativeTemplateId): boolean { return typeof handlers[id] === 'function'; }
