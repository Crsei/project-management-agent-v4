import path from 'node:path';
import { z } from 'zod';
import { prepareReportDirectory } from '../reports/files.ts';
import { datasetRegistryStatus, enrollCanonicalDatasetVersion, promoteDatasetVersion, recordDatasetExposure, validateDatasetVersion } from './dataset.ts';
import { exclusiveJson, privateDirectory, privateJson, reservedOutput } from './dataset-files.ts';
import { applyOnlineFence, createContentPreview, expireFeedbackSources, exportFeedbackMetadata, grantContentPermission, importFeedbackMetadata, importOnlineFeedback, intakeFeedback, readContentPreview, registerReproduction, RegistryIdSchema, reviewContentPreview, triageFeedback, validateFeedbackExport, withdrawFeedbackSource } from './feedback.ts';

export const DATASET_COMMANDS = [
  'feedback-intake', 'feedback-triage', 'feedback-content-permission', 'feedback-preview', 'feedback-preview-review', 'feedback-preview-show',
  'feedback-reproduction', 'feedback-withdraw', 'feedback-expire', 'feedback-export', 'feedback-export-validate', 'feedback-import', 'feedback-restore',
  'feedback-import-online', 'feedback-online-fence', 'feedback-status', 'dataset-enroll', 'dataset-promote', 'dataset-expose', 'dataset-validate',
] as const;
export const DATASET_COMMAND_FLAGS = ['input', 'output-root', 'registry'] as const;

/** Every operation is explicit, offline and local. No command invokes a model or PM operation. */
export async function runDatasetCommand(command: string, flags: Record<string, string>): Promise<{ exitCode: number; result: unknown } | undefined> {
  if (!DATASET_COMMANDS.some(supported => supported === command)) return undefined;
  for (const name of Object.keys(flags)) if (!DATASET_COMMAND_FLAGS.some(allowed => allowed === name)) throw new Error(`Unsupported --${name} for ${command}`);
  if (!flags.input || !flags.registry || !flags['output-root']) throw new Error(`${command} requires --input FILE --registry DIR --output-root DIR`);
  const registry = reservedOutput(flags.registry), outputRoot = reservedOutput(flags['output-root']);
  const relative = path.relative(registry, outputRoot), reverse = path.relative(outputRoot, registry);
  if (!relative || !relative.startsWith('..') && !path.isAbsolute(relative) || !reverse.startsWith('..') && !path.isAbsolute(reverse)) throw new Error('Registry and command output roots must be separate nonoverlapping private directories');
  const input = await privateJson(flags.input);
  // Reserve outputs before mutations: rerunning a command cannot silently replace its original result.
  await prepareReportDirectory(outputRoot, true);
  await privateDirectory(outputRoot);
  let result: unknown;
  switch (command) {
    case 'feedback-intake': result = await intakeFeedback(registry, input); break;
    case 'feedback-triage': result = await triageFeedback(registry, input); break;
    case 'feedback-content-permission': result = await grantContentPermission(registry, input); break;
    case 'feedback-preview': result = await createContentPreview(registry, input); break;
    case 'feedback-preview-review': result = await reviewContentPreview(registry, input); break;
    case 'feedback-preview-show': {
      const selection = z.object({ previewId: RegistryIdSchema }).strict().parse(input);
      // This is the bounded manual review surface, not a durable content export. Only metadata is written below.
      result = await readContentPreview(registry, selection.previewId);
      await exclusiveJson(path.join(outputRoot, 'result.json'), { previewId: selection.previewId, previewOnly: true, contentPersisted: false });
      return { exitCode: 0, result };
    }
    case 'feedback-reproduction': result = await registerReproduction(registry, input); break;
    case 'feedback-withdraw': result = await withdrawFeedbackSource(registry, input); break;
    case 'feedback-expire': {
      const selection = z.object({ actorId: RegistryIdSchema }).strict().parse(input);
      result = await expireFeedbackSources(registry, selection.actorId); break;
    }
    case 'feedback-export': {
      const selection = z.object({ exportId: RegistryIdSchema }).strict().parse(input);
      result = await exportFeedbackMetadata(registry, selection.exportId); break;
    }
    case 'feedback-export-validate': result = await validateFeedbackExport(registry, input); break;
    case 'feedback-import': result = await importFeedbackMetadata(registry, input); break;
    case 'feedback-restore': result = { restoration: 'metadata-claims-only', restored: await importFeedbackMetadata(registry, input), permissionsRestored: false, labelsRestored: false, contentRestored: false }; break;
    case 'feedback-import-online': result = await importOnlineFeedback(registry, input); break;
    case 'feedback-online-fence': await applyOnlineFence(registry, input); result = { fenceApplied: true, pmFactsChanged: false }; break;
    case 'feedback-status': z.object({}).strict().parse(input); result = await datasetRegistryStatus(registry); break;
    case 'dataset-enroll': result = await enrollCanonicalDatasetVersion(registry, input); break;
    case 'dataset-promote': result = await promoteDatasetVersion(registry, input); break;
    case 'dataset-expose': result = await recordDatasetExposure(registry, input); break;
    case 'dataset-validate': {
      const selection = z.object({ datasetId: RegistryIdSchema, version: RegistryIdSchema }).strict().parse(input);
      result = await validateDatasetVersion({ registryRoot: registry, ...selection }); break;
    }
    default: throw new Error('Unsupported dataset lifecycle command');
  }
  await exclusiveJson(path.join(outputRoot, 'result.json'), result);
  return { exitCode: 0, result };
}
