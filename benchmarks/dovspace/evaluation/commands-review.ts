import { open } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { prepareReportDirectory, readReportJson } from '../reports/files.ts';
import { readStudyResults, writeStudyReport } from '../reports/tools-study.ts';
import { createEvaluationReview, ReviewRequestSchema, evaluationDigest } from './review.ts';
import { readLocalPolicyApprovals, readReleaseMaterial, validateReleaseMaterial } from './release-material.ts';
import { trustedReviewAuthority } from './release.ts';

export const REVIEW_COMMAND_FLAGS: Record<string, readonly string[]> = {
  'review-create': ['input', 'output-root', 'registry'],
  'review-study': ['input', 'study-results', 'output-root', 'registry'],
  'release-decide': ['input', 'input-sha256', 'output-root', 'registry'],
  'release-validate': ['input', 'input-sha256', 'output-root', 'registry'],
};

/** The parent dispatcher owns parsing. Unknown commands alone return undefined; unsupported flags fail closed. */
export async function runReviewCommand(command: string, flags: Record<string, string>): Promise<{ exitCode: number; result: unknown } | undefined> {
  const allowed = REVIEW_COMMAND_FLAGS[command];
  if (!allowed) return undefined;
  for (const flag of Object.keys(flags)) if (!allowed.includes(flag)) throw new Error(`Unsupported ${command} flag: --${flag}`);
  for (const flag of allowed) if (!flags[flag]?.trim()) throw new Error(`${command} requires --${flag}`);
  const benchmarkRoot = resolve(import.meta.dirname, '..'), outputsRoot = resolve(benchmarkRoot, 'outputs');
  const output = isAbsolute(flags['output-root']!) ? resolve(flags['output-root']!) : resolve(benchmarkRoot, flags['output-root']!);
  const child = relative(outputsRoot, output);
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Review outputs must be descendants of reserved benchmarks/dovspace/outputs');
  const input = resolve(flags.input!), registryRoot = resolve(flags.registry!);
  let review: unknown, decision: { status: string } | undefined;
  if (command === 'review-create' || command === 'review-study') {
    const request = ReviewRequestSchema.parse(await readReportJson(input));
    if (request.ledgerRoot) request.ledgerRoot = resolve(dirname(input), request.ledgerRoot);
    const authority = trustedReviewAuthority(await readLocalPolicyApprovals(), evaluationDigest(request.experiment));
    request.archives = request.archives.map(reference => ({ ...reference,
      archiveRoot: resolve(dirname(input), reference.archiveRoot), gradePath: resolve(dirname(input), reference.gradePath),
      ...(reference.evaluatorPath ? { evaluatorPath: resolve(dirname(input), reference.evaluatorPath) } : {}),
      ...(reference.calibrationPath ? { calibrationPath: resolve(dirname(input), reference.calibrationPath) } : {}),
      ...(reference.captureAttestationPath ? { captureAttestationPath: resolve(dirname(input), reference.captureAttestationPath) } : {}) }));
    if (command === 'review-study') {
      const study = await readStudyResults(resolve(flags['study-results']!));
      await prepareReportDirectory(output, true);
      const summary = await writeStudyReport(study.runs, study.manifest, output, { request, registryRoot, ...(authority ? { authority } : {}) });
      return { exitCode: summary.fairness.valid && !summary.safetyVeto ? 0 : 1,
        result: { command, inferencePerformed: false, regradePerformed: false, publicationAuthority: false,
          outputRoot: output, status: summary.conclusion, reviewId: summary.evaluationReview?.reviewId } };
    }
    review = await createEvaluationReview(request, registryRoot, authority);
  } else {
    const loaded = await readReleaseMaterial(input, flags['input-sha256']!);
    const checked = await validateReleaseMaterial({ ...loaded, registryRoot, approvals: await readLocalPolicyApprovals() });
    review = checked.review; decision = checked.decision;
  }
  await prepareReportDirectory(output, true);
  const documents: Array<[string, unknown]> = [['review.json', review]];
  if (decision) documents.push(['decision.json', decision]);
  for (const [name, value] of documents) {
    const file = await open(resolve(output, name), 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await file.close(); }
  }
  return { exitCode: decision?.status === 'blocked' ? 1 : 0, result: { command, inferencePerformed: false,
    regradePerformed: false, publicationAuthority: false, outputRoot: output, status: decision?.status ?? 'reviewed' } };
}
