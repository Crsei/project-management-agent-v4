import { z } from 'zod';
import { DomainError } from './core.ts';
import type { Entity } from './core.ts';

export const artifactTitleSchema = z.string().trim().min(1).max(20_000);
export const artifactKindSchema = z.string().trim().min(1).max(100);
export const artifactLifecyclePayloads = {
  RenameArtifact: z.strictObject({ title: artifactTitleSchema }),
  HideArtifact: z.strictObject({}),
  RestoreArtifact: z.strictObject({}),
  CopyArtifactVersion: z.strictObject({ targetTitle: artifactTitleSchema, targetKind: artifactKindSchema }),
};

export function assertArtifactVisible(artifact: Entity): void {
  if (artifact.data.hiddenAt !== null) throw new DomainError('artifact_hidden', 'Restore this artifact before editing it', 409);
}
