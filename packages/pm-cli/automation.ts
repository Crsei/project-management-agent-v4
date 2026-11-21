import { z } from 'zod';
import { type CliFamily, type CliRuntime, parseOptions, inputFile, nonempty, objectInput } from './runtime.ts';
import { studioActionKindSchema, studioConfigSchema, studioCreateSchema, studioUpdateSchema, studioRevisionSchema, studioStatusSchema, studioDispatchSchema, studioCancelSchema } from '../contracts/src/automation-studio.ts';
import { pmAutomationCandidateEditSchema, pmAutomationPreviewRequestSchema, pmAutomationApplyRequestSchema, pmAutomationReviewRequestSchema } from '../contracts/src/automation-pm.ts';
import { automationTransferPreviewSchema, automationTransferImportSchema, automationBundleUploadSchema } from '../contracts/src/automation-transfer.ts';
import { automationGitSaveSchema, automationGitCheckSchema, automationGitRunSchema } from '../contracts/src/automation-git-sync.ts';
import { automationCatalog } from '../automation-resources/catalog.ts';
import { pmAutomationCatalogSource } from '../automation-resources/pm-catalog.ts';
import { parseDocument } from 'yaml';
import path from 'node:path';
import { readPrivateFile } from './private-files.ts';

const uuid = z.uuid().toLowerCase(), project = z.string().regex(/^PRJ-\d+$/);
const help = `automation capabilities --project PRJ-ID [--action prompt|script|template]
automation templates [--id TEMPLATE] [--source pm|openhands]
automation timezones [--search TEXT]
automation definitions [--project PRJ-ID] [--quick-access true|false] [--cursor UUID]
automation definition ID
automation create|validate --file FILE
automation update|status|remove|run|test ID --file FILE
automation executions [--project PRJ-ID] [--definition UUID] [--cursor UUID]
automation execution|query ID
automation cancel ID --file FILE
automation logs ID [--cursor SEQUENCE]
automation receipt REQUEST-ID
automation snapshot|result EXECUTION-ID
automation candidate edit|preview|apply|ignore EXECUTION-ID CANDIDATE-ID --file FILE
automation review-receipt REQUEST-ID
automation import-preview|import|bundle-upload --file FILE
automation import-receipt|bundle-receipt REQUEST-ID
automation export DEFINITION-ID [--format bundle|source]
automation git status --project PRJ-ID
automation git save|check|sync|reconcile --file FILE
automation git receipt REQUEST-ID
Files use the exact native request schema, including an explicit original requestId for writes and expectedRevision for CAS. create uses {requestId,config}; validate uses {config}. Trigger/timezone/quickAccess are saved within config. Saving never runs. test REALLY executes and can have external side effects. Candidate preview writes only its native audit receipt, not business objects. Unknown writes are never retried: receipt/review-receipt/import-receipt/bundle-receipt/git receipt inspect the original request; query inspects the original execution. Git save/check --file requires an owned regular 0600 file under protected directories; parse/schema failures never print source values. Never put secrets in arguments or model tools.`;
function usage(): never { throw new Error(`Usage: pm ${help}`); }
function exactPositionals(args: string[], count: number): string[] { if (args.length !== count || args.some(arg => arg.startsWith('--'))) usage(); return args; }
async function send(runtime: CliRuntime, endpoint: string, method?: string, body?: unknown): Promise<void> {
  runtime.print(await runtime.json('workspace', `/automations${endpoint}`, { ...(method ? { method } : {}), ...(body === undefined ? {} : { body }) }));
}
async function privateGitInput(operation: 'save' | 'check', filename: string | undefined) {
  try {
    const text = await readPrivateFile(path.resolve(nonempty(filename, '--file')));
    if (!text) throw new Error();
    const document = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
    if (document.errors.length) throw new Error();
    const input = objectInput(document.toJS({ maxAliasCount: 0 }));
    const parsed = operation === 'save' ? automationGitSaveSchema.safeParse(input) : automationGitCheckSchema.safeParse(input);
    if (!parsed.success) throw new Error();
    return parsed.data;
  } catch {
    throw new Error('Git save/check input must be a strict JSON/YAML object in an owned regular 0600 file under protected directories (64 KiB maximum); input values were not printed.');
  }
}
export const automationFamily: CliFamily = {
  help,
  async dispatch(args, runtime) {
    if (args[0] !== 'automation') return false;
    const action = args[1], rest = args.slice(2);
    switch (action) {
      case 'templates': { const p = parseOptions(rest, ['id']); const items = automationCatalog.filter(t => !p.id || t.id === p.id); if (p.id && !items.length) throw new Error('Unknown automation template ID'); runtime.print({ source: pmAutomationCatalogSource, items }); return true; }
      case 'timezones': { const p = parseOptions(rest, ['search']); runtime.print({ items: ['UTC', ...Intl.supportedValuesOf('timeZone')].sort().filter(zone => !p.search || zone.toLowerCase().includes(p.search.toLowerCase())) }); return true; }
      case 'capabilities': { const p = parseOptions(rest, ['project', 'action']), q = new URLSearchParams({ projectId: project.parse(nonempty(p.project, '--project')) }); if (p.action !== undefined) q.set('actionKind', studioActionKindSchema.parse(p.action)); await send(runtime, `/studio-capabilities?${q}`); return true; }
      case 'definitions': { const p = parseOptions(rest, ['project', 'quick-access', 'cursor']), q = new URLSearchParams(); if (p.project !== undefined) q.set('projectId', project.parse(p.project)); if (p['quick-access'] !== undefined) q.set('quickAccess', z.enum(['true', 'false']).parse(p['quick-access'])); if (p.cursor !== undefined) q.set('cursor', uuid.parse(p.cursor)); await send(runtime, `/definitions${q.size ? `?${q}` : ''}`); return true; }
      case 'definition': { exactPositionals(rest, 1); await send(runtime, `/definitions/${uuid.parse(rest[0])}`); return true; }
      case 'create': case 'validate': { const p = parseOptions(rest, ['file']), raw = await inputFile(p.file); if (action === 'create') await send(runtime, '/definitions', 'POST', studioCreateSchema.parse(raw)); else await send(runtime, '/definitions/validate', 'POST', z.strictObject({ config: studioConfigSchema }).parse(raw)); return true; }
      case 'update': case 'status': case 'remove': case 'run': case 'test': { const id = uuid.parse(rest[0]), p = parseOptions(rest.slice(1), ['file']), raw = await inputFile(p.file); switch (action) { case 'update': await send(runtime, `/definitions/${id}`, 'PUT', studioUpdateSchema.parse(raw)); break; case 'status': await send(runtime, `/definitions/${id}/status`, 'POST', studioStatusSchema.parse(raw)); break; case 'remove': await send(runtime, `/definitions/${id}`, 'DELETE', studioRevisionSchema.parse(raw)); break; case 'run': case 'test': await send(runtime, `/definitions/${id}/${action}`, 'POST', studioDispatchSchema.parse(raw)); break; } return true; }
      case 'executions': { const p = parseOptions(rest, ['project', 'definition', 'cursor']), q = new URLSearchParams(); if (p.project !== undefined) q.set('projectId', project.parse(p.project)); if (p.definition !== undefined) q.set('definitionId', uuid.parse(p.definition)); if (p.cursor !== undefined) q.set('cursor', uuid.parse(p.cursor)); await send(runtime, `/executions${q.size ? `?${q}` : ''}`); return true; }
      case 'execution': case 'query': { exactPositionals(rest, 1); const id = uuid.parse(rest[0]); await send(runtime, `/executions/${id}${action === 'query' ? '/query' : ''}`, action === 'query' ? 'POST' : undefined, action === 'query' ? {} : undefined); return true; }
      case 'cancel': { const id = uuid.parse(rest[0]), p = parseOptions(rest.slice(1), ['file']); await send(runtime, `/executions/${id}/cancel`, 'POST', studioCancelSchema.parse(await inputFile(p.file))); return true; }
      case 'logs': { const id = uuid.parse(rest[0]), p = parseOptions(rest.slice(1), ['cursor']); const cursor = p.cursor === undefined ? '' : `?cursor=${z.string().regex(/^\d{1,16}$/).parse(p.cursor)}`; await send(runtime, `/executions/${id}/logs${cursor}`); return true; }
      case 'receipt': case 'review-receipt': case 'import-receipt': case 'bundle-receipt': { exactPositionals(rest, 1); const id = uuid.parse(rest[0]); const paths = { receipt: '/studio-receipts/', 'review-receipt': '/pm/receipts/', 'import-receipt': '/transfer/imports/', 'bundle-receipt': '/transfer/bundles/receipts/' } as const; await send(runtime, `${paths[action]}${id}`); return true; }
      case 'snapshot': case 'result': { exactPositionals(rest, 1); await send(runtime, `/pm/executions/${uuid.parse(rest[0])}/${action}`); return true; }
      case 'candidate': { const operation = z.enum(['edit', 'preview', 'apply', 'ignore']).parse(rest[0]), executionId = uuid.parse(rest[1]), candidateId = z.string().min(1).max(300).parse(rest[2]), p = parseOptions(rest.slice(3), ['file']), raw = await inputFile(p.file); const body = operation === 'edit' ? pmAutomationCandidateEditSchema.parse(raw) : operation === 'preview' ? pmAutomationPreviewRequestSchema.parse(raw) : operation === 'apply' ? pmAutomationApplyRequestSchema.parse(raw) : pmAutomationReviewRequestSchema.parse(raw); await send(runtime, `/pm/executions/${executionId}/candidates/${encodeURIComponent(candidateId)}${operation === 'edit' ? '' : `/${operation}`}`, operation === 'edit' ? 'PATCH' : 'POST', body); return true; }
      case 'import-preview': case 'import': case 'bundle-upload': { const p = parseOptions(rest, ['file']), raw = await inputFile(p.file); const endpoint = action === 'import-preview' ? '/transfer/preview' : action === 'import' ? '/transfer/imports' : '/transfer/bundles', body = action === 'import-preview' ? automationTransferPreviewSchema.parse(raw) : action === 'import' ? automationTransferImportSchema.parse(raw) : automationBundleUploadSchema.parse(raw); await send(runtime, endpoint, 'POST', body); return true; }
      case 'export': { const id = uuid.parse(rest[0]), p = parseOptions(rest.slice(1), ['format']), format = z.enum(['bundle', 'source']).parse(p.format ?? 'bundle'); await send(runtime, `/transfer/definitions/${id}?format=${format}`); return true; }
      case 'git': {
        const operation = rest[0], tail = rest.slice(1);
        switch (operation) {
          case 'status': { const p = parseOptions(tail, ['project']); await send(runtime, `/git-sync?projectId=${project.parse(nonempty(p.project, '--project'))}`); break; }
          case 'receipt': exactPositionals(tail, 1); await send(runtime, `/git-sync/receipts/${uuid.parse(tail[0])}`); break;
          case 'save': case 'check': { const p = parseOptions(tail, ['file']), body = await privateGitInput(operation, p.file); await send(runtime, `/git-sync${operation === 'save' ? '' : '/check'}`, operation === 'save' ? 'PUT' : 'POST', body); break; }
          case 'sync': case 'reconcile': { const p = parseOptions(tail, ['file']), body = automationGitRunSchema.parse(await inputFile(p.file)); await send(runtime, `/git-sync/${operation}`, 'POST', body); break; }
          default: usage();
        }
        return true;
      }
      default: usage();
    }
  },
};
