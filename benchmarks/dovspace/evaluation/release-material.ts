import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { readReportJson } from '../reports/files.ts';
import { createEvaluationReview, Digest, ReviewRequestSchema, evaluationDigest } from './review.ts';
import { decideRelease, PolicyApprovalRegistrySchema, ReleaseDecisionRequestSchema, trustedReviewAuthority } from './release.ts';
import { safeEvidenceBytes } from './archive.ts';

export const ReleaseMaterialSchema = z.object({ schemaVersion: z.literal(1), reviewRequest: ReviewRequestSchema,
  decisionRequest: ReleaseDecisionRequestSchema, registryDirectory: z.string().min(1), registrySourcePath: z.string().min(1) }).strict();
export type ReleaseMaterial = z.infer<typeof ReleaseMaterialSchema>;

/** Material paths are data, never host capabilities. Every file reader additionally refuses redirected ancestors. */
export function resolveMaterialPath(root: string, value: string): string {
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127) throw new Error('Release material path must be a contained relative path');
  if (isAbsolute(value) || value.includes('\\') || value.split('/').some(part => part === '..')) throw new Error('Release material path must be a contained relative path');
  const target = resolve(root, value), child = relative(resolve(root), target);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Release material path must be below its private bundle root');
  return target;
}

export async function readReleaseMaterial(filePath: string, expectedSha256: string): Promise<{ material: ReleaseMaterial; root: string }> {
  Digest.parse(expectedSha256);
  const absolute = resolve(filePath), bytes = await safeEvidenceBytes(absolute);
  if (bytes.length > 4 * 1024 * 1024) throw new Error('Release material exceeds bounded metadata size');
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('Release material bytes differ from the independently supplied SHA256');
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw new Error('Malformed release material JSON (input withheld)'); }
  return { material: ReleaseMaterialSchema.parse(parsed), root: dirname(absolute) };
}

/** Always re-read archives, grades, calibration identities and live deletion fences; serialized green decisions are not authority. */
export async function validateReleaseMaterial(options: { material: ReleaseMaterial; root: string; registryRoot: string;
  approvals: unknown; expectedCandidateSourceSha?: string; expectedProductSha256?: string; expectedArtifactSetSha256?: string; now?: Date }) {
  const material = ReleaseMaterialSchema.parse(options.material), approvals = PolicyApprovalRegistrySchema.parse(options.approvals);
  const request = { ...material.reviewRequest,
    ...(material.reviewRequest.ledgerRoot ? { ledgerRoot: resolveMaterialPath(options.root, material.reviewRequest.ledgerRoot) } : {}),
    archives: material.reviewRequest.archives.map(reference => ({ ...reference,
    archiveRoot: resolveMaterialPath(options.root, reference.archiveRoot), gradePath: resolveMaterialPath(options.root, reference.gradePath),
    ...(reference.evaluatorPath ? { evaluatorPath: resolveMaterialPath(options.root, reference.evaluatorPath) } : {}),
    ...(reference.calibrationPath ? { calibrationPath: resolveMaterialPath(options.root, reference.calibrationPath) } : {}),
    ...(reference.captureAttestationPath ? { captureAttestationPath: resolveMaterialPath(options.root, reference.captureAttestationPath) } : {}) })) };
  const authority = trustedReviewAuthority(approvals, evaluationDigest(request.experiment), evaluationDigest(material.decisionRequest.policy));
  const review = await createEvaluationReview(request, options.registryRoot, authority);
  const decision = decideRelease(material.decisionRequest, review, approvals, options.now);
  if (options.expectedCandidateSourceSha !== undefined && decision.candidate.sourceSha !== options.expectedCandidateSourceSha) throw new Error('Release decision candidate does not match the actual desktop source commit');
  if (options.expectedProductSha256 !== undefined && decision.candidate.productSha256 !== options.expectedProductSha256) throw new Error('Release decision candidate does not match the actual built public-source bytes');
  if (options.expectedArtifactSetSha256 !== undefined && decision.artifactSetSha256 !== options.expectedArtifactSetSha256) throw new Error('Release decision does not match the exact final desktop artifact set');
  return { review, decision, decisionRequestSha256: evaluationDigest(material.decisionRequest) };
}

export async function readLocalPolicyApprovals(file = new URL('./release-policy-registry.json', import.meta.url).pathname) {
  return PolicyApprovalRegistrySchema.parse(await readReportJson(file));
}
