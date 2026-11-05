import { automationCatalogById } from './catalog.ts';
import { studioNativeTemplateIdSchema } from '../contracts/src/automation-studio.ts';
import { isPmAutomationTemplateId, pmAutomationArgumentsSchema } from '../contracts/src/automation-pm.ts';

export type NativeTemplateArgumentIssue = { path: string; code: string; message: string };
/** Source-form values only. Authentication comes from revisioned scoped connectors, never secret names here. */
export function validateNativeTemplateArguments(id: string, arguments_: Readonly<Record<string, unknown>>): NativeTemplateArgumentIssue[] {
  const issues: NativeTemplateArgumentIssue[] = [];
  const add = (key: string, message: string) => issues.push({ path: `action.arguments${key ? `.${key}` : ''}`, code: 'invalid_template_argument', message });
  if (!studioNativeTemplateIdSchema.safeParse(id).success) { add('', 'Unknown native automation template.'); return issues; }
  if (isPmAutomationTemplateId(id)) {
    const parsed = pmAutomationArgumentsSchema.safeParse(arguments_);
    if (!parsed.success) for (const issue of parsed.error.issues) {
      const key = issue.path.join('.');
      add(key, issue.message);
    }
    return issues;
  }
  const fields = automationCatalogById.get(id)!.setup!.form.args;
  for (const key of Object.keys(arguments_)) if (!Object.hasOwn(fields, key)) add(key, 'This field is not part of the pinned template form.');
  for (const [key, field] of Object.entries(fields)) {
    const value = arguments_[key];
    if (value === undefined || value === null || value === '') {
      if (field.required) add(key, `${field.label} is required; persist the selected/default value explicitly.`);
      continue;
    }
    const constraints = field.constraints;
    if (field.type === 'repo-picker') {
      const repositories = field.multiple ? value : [value];
      if (!Array.isArray(repositories) || repositories.length === 0 || repositories.length > 20) { add(key, 'Select between 1 and 20 repository identifiers.'); continue; }
      const seen = new Set<string>();
      for (const repository of repositories) {
        if (typeof repository !== 'string' || repository.length > 300 || repository !== repository.trim()) { add(key, 'Repository identifiers must be trimmed owner/repository or group/project strings.'); continue; }
        const parts = repository.split('/');
        if (parts.length < 2 || (field.provider === 'github' && parts.length !== 2) || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) add(key, `Invalid ${field.provider ?? ''} repository identifier.`);
        const normalized = field.provider === 'github' ? repository.toLowerCase() : repository;
        if (seen.has(normalized)) add(key, 'A repository cannot be selected twice.');
        seen.add(normalized);
      }
    } else if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || (constraints?.min !== undefined && value < constraints.min) || (constraints?.max !== undefined && value > constraints.max)) add(key, `${field.label} must be an integer within its declared range.`);
    } else if (typeof value !== 'string') add(key, `${field.label} must be text.`);
    else {
      if (value.length > (constraints?.maxLength ?? 10000) || (constraints?.minLength !== undefined && value.length < constraints.minLength)) add(key, `${field.label} has an invalid length.`);
      if (value.includes('\0')) add(key, 'Null bytes are not allowed.');
      if (field.type === 'select' && !field.options?.some(option => option.value === value)) add(key, 'Select one of the declared options.');
      if (constraints?.format === 'safeExpressionLiteral' && /["'`\\\r\n]/.test(value)) add(key, 'The value contains an unsafe expression literal.');
    }
  }
  const secretName = arguments_.githubTokenSecret;
  if (typeof secretName === 'string' && !/^[A-Z_][A-Z0-9_]*$/.test(secretName)) add('githubTokenSecret', 'Enter a source secret name, never a credential value; native authentication uses the selected connection.');
  const branch = arguments_.branchPrefix;
  if (typeof branch === 'string' && (/^[./-]|\/$|\.\.|@\{|[\x00-\x20\x7f~^:?*\[\\]/.test(branch) || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')))) add('branchPrefix', 'Choose a valid Git branch prefix.');
  if (id === 'news-digest' && typeof arguments_.feeds === 'string') {
    const feeds = arguments_.feeds.split(/[\n,]/).map(value => value.trim()).filter(Boolean);
    if (feeds.length === 0 || feeds.length > 50) add('feeds', 'Provide between 1 and 50 public HTTPS feed URLs.');
    for (const value of feeds) {
      try { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.hash) add('feeds', 'Feeds must be public HTTPS URLs without credentials or fragments.'); }
      catch { add('feeds', 'A feed URL is invalid.'); }
    }
  }
  if (id === 'gitlab-issue-to-mr' && typeof arguments_.gitlabApiUrl === 'string') {
    try { const url = new URL(arguments_.gitlabApiUrl); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/api\/v4\/?$/.test(url.pathname)) add('gitlabApiUrl', 'Use the approved GitLab HTTPS API root ending in /api/v4.'); }
    catch { add('gitlabApiUrl', 'The GitLab API root is invalid.'); }
  }
  return issues;
}
