import { isPmAutomationTemplateId, pmAutomationArgumentsSchema } from '../contracts/src/automation-pm.ts';
import { studioNativeTemplateIdSchema } from '../contracts/src/automation-studio.ts';

export type NativeTemplateArgumentIssue = { path: string; code: string; message: string };
/** PM-native template arguments only. Authentication comes from revisioned scoped connectors, never secret names here. */
export function validateNativeTemplateArguments(id: string, arguments_: Readonly<Record<string, unknown>>): NativeTemplateArgumentIssue[] {
  const issues: NativeTemplateArgumentIssue[] = [];
  const add = (key: string, message: string) => issues.push({ path: `action.arguments${key ? `.${key}` : ''}`, code: 'invalid_template_argument', message });
  if (!studioNativeTemplateIdSchema.safeParse(id).success || !isPmAutomationTemplateId(id)) { add('', 'Unknown native automation template.'); return issues; }
  const parsed = pmAutomationArgumentsSchema.safeParse(arguments_);
  if (!parsed.success) for (const issue of parsed.error.issues) add(issue.path.join('.'), issue.message);
  return issues;
}
