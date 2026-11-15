import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { collectSourceManifest } from '../isolation/source.ts';
import { SourceManifestSchema, type SourceManifest } from '../schemas/types.ts';
import { StudyManifestSchema, type StudyManifest } from '../schemas/tools-study.ts';
import { parseBenchmarkConfig, repositoryRoot } from '../benchmark.config.ts';
import { hashValue } from './telemetry.ts';

export async function collectStudyHarnessHash(): Promise<string> {
  const root = resolve(repositoryRoot, 'benchmarks/dovspace');
  const files: Array<{ path: string; sha256: string }> = [];
  async function visit(path: string): Promise<void> {
    const absolute = resolve(root, path), info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw new Error('Harness inputs must be regular independent files');
    if (info.isDirectory()) {
      for (const name of await readdir(absolute)) if (!name.startsWith('.') && !name.endsWith('.test.ts') && name !== 'node_modules') await visit(`${path}/${name}`);
    } else files.push({ path, sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') });
  }
  for (const path of ['adapters', 'fixtures', 'graders', 'isolation', 'pm-tools', 'reports', 'runners', 'schemas', 'tasks', 'benchmark.config.ts', 'cli.ts']) await visit(path);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return hashValue(files);
}
/** Canonical path/hash reconstruction, not a caller-provided common-environment label. */
export interface StudySourceProof { manifest: StudyManifest; manifestHash: string; differences: StudyManifest['treatment'] }
const verifiedStudies = new WeakMap<StudySourceProof, string>();

/** A structural object or caller-selected hash is not a source-verification capability. */
export function hasVerifiedStudySourceProof(proof: StudySourceProof | null, manifestHash: string): boolean {
  return proof !== null && verifiedStudies.get(proof) === manifestHash && hashValue(proof.manifest) === manifestHash;
}
export function verifySourceManifest(input: unknown): SourceManifest {
  const manifest = SourceManifestSchema.parse(input);
  const files = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of files) if (file.path.includes('\\') || file.path.startsWith('/') || file.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Source manifest contains a noncanonical relative path');
  if (new Set(files.map(file => file.path)).size !== files.length || hashValue(files) !== manifest.sourceHash) throw new Error('Source file list does not reconstruct the actual source hash');
  if (!files.some(file => file.path === 'pnpm-lock.yaml')) throw new Error('Source manifest must preserve the dependency lockfile');
  return { ...manifest, files };
}

export function proveTreatment(input: unknown): StudySourceProof {
  const manifest = StudyManifestSchema.parse(input);
  parseBenchmarkConfig(manifest.controls); // Applies the same endpoint/provider/options safety gates as execution.
  const baseline = verifySourceManifest(manifest.variants.baseline.sourceManifest), candidate = verifySourceManifest(manifest.variants.candidate.sourceManifest);
  const before = new Map(baseline.files.map(file => [file.path, file.sha256])), after = new Map(candidate.files.map(file => [file.path, file.sha256]));
  const declared = new Map(manifest.treatment.map(item => [item.path, item]));
  if (declared.size !== manifest.treatment.length) throw new Error('Treatment paths must be exact and unique');
  const differences: StudyManifest['treatment'] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (before.get(path) === after.get(path)) continue;
    const item = declared.get(path);
    if (!item || item.baseline !== (before.get(path) ?? null) || item.candidate !== (after.get(path) ?? null)) throw new Error(`Foreign/unproved source difference outside preregistered treatment: ${path}`);
    if (/(?:^|\/)(?:package\.json|[^/]*lock[^/]*|tsconfig[^/]*|[^/]*\.config\.[^/]+)$/.test(path) || !/^(?:packages\/application\/src\/|apps\/server\/(?:pm|agent)\/src\/|vendor\/t3code\/packages\/provider-omp\/src\/)/.test(path)) throw new Error(`Treatment cannot change dependency, runtime, permission or unrelated source controls: ${path}`);
    differences.push(item);
  }
  if (!differences.length || differences.length !== declared.size) throw new Error('Treatment must be the exact nonempty minimal actual source difference; unchanged/extra paths are forbidden');
  if (baseline.files.find(file => file.path === 'pnpm-lock.yaml')?.sha256 !== candidate.files.find(file => file.path === 'pnpm-lock.yaml')?.sha256) throw new Error('Dependency lockfile differs');
  return { manifest, manifestHash: hashValue(manifest), differences };
}

export async function verifyStudySources(input: unknown): Promise<StudySourceProof> {
  const proof = proveTreatment(input);
  if (proof.manifest.evidenceKind !== 'report-fixture' && proof.manifest.harnessHash !== await collectStudyHarnessHash()) throw new Error('Task/grader/collector/runtime harness differs from preregistered controls');
  const roots: string[] = [];
  for (const variant of ['baseline', 'candidate'] as const) {
    const selected = proof.manifest.variants[variant];
    if (!isAbsolute(selected.sourceRoot) || resolve(selected.sourceRoot) !== selected.sourceRoot || await realpath(selected.sourceRoot) !== selected.sourceRoot) throw new Error('Study sources must be explicit canonical independent source directories');
    if (selected.sourceRoot === resolve(repositoryRoot)) throw new Error('Study variants must be independently frozen/staged, not the mutable implementation checkout');
    const actual = verifySourceManifest(await collectSourceManifest(selected.sourceRoot));
    if (hashValue(actual) !== hashValue(verifySourceManifest(selected.sourceManifest))) throw new Error(`${variant}: actual source bytes differ from preregistered manifest`);
    roots.push(selected.sourceRoot);
  }
  const child = relative(roots[0]!, roots[1]!);
  const reverse = relative(roots[1]!, roots[0]!);
  if (!child || !(child === '..' || child.startsWith(`..${sep}`)) || !(reverse === '..' || reverse.startsWith(`..${sep}`))) throw new Error('Baseline/candidate must be independently staged, not equal or nested directories');
  verifiedStudies.set(proof, proof.manifestHash);
  return proof;
}
