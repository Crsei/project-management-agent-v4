import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { inventorySessionCutover, applySessionCutover, withOfflineSessionCutover, type SessionCutoverPlan } from '../apps/server/agent/src/maintenance/session-cutover.ts';

const { values } = parseArgs({ options: { data: { type: 'string' }, stopped: { type: 'boolean' }, output: { type: 'string' }, apply: { type: 'boolean' }, plan: { type: 'string' } }, strict: true, allowPositionals: false });
if (!values.data || !values.stopped || values.apply && !values.plan || !values.apply && values.plan) {
  throw new Error('Usage: node scripts/agent-session-cutover.ts --data /absolute/AgentData --stopped [--output /private/new-plan.json] OR --apply --plan /private/reviewed-plan.json. Default is inventory only. Stop only this application Agent first; no service is stopped by this command.');
}
const result = withOfflineSessionCutover(values.data, values.stopped, (db, root) => values.apply
  ? applySessionCutover(db, JSON.parse(readFileSync(values.plan!, 'utf8')) as SessionCutoverPlan, root)
  : inventorySessionCutover(db, root));
if (values.output) writeFileSync(values.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ mode: values.apply ? 'applied' : 'inventory-only', dataDirectory: result.dataDirectory, fingerprint: result.fingerprint,
  candidateIds: result.candidateIds, generationCount: result.generationIds.length, retainedBusinessEvidenceGenerationIds: result.retainedGenerationIds,
  references: result.references, blockers: result.blockers, unclassifiedNamespaces: result.unclassifiedNamespaces,
  ...(values.output ? { planFile: values.output } : {}), preservation: 'PM business records, repository directories/worktrees, external CLI history and Provider accounts/settings are untouched. Business-referenced generation/output evidence is retained but Sessions are tombstoned and unusable.' }, null, 2));
