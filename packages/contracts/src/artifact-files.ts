import { z } from 'zod';

export const artifactVisibilitySchema = z.enum(['visible', 'hidden', 'all']);
export type ArtifactVisibility = z.infer<typeof artifactVisibilitySchema>;
export const artifactCopyOriginSchema = z.strictObject({
  sourceProjectId: z.string(), sourceArtifactId: z.uuid(), sourceArtifactVersionId: z.uuid(),
  copiedAt: z.iso.datetime({ offset: true }),
});
export const artifactCopyOriginResponseSchema = z.strictObject({ origin: artifactCopyOriginSchema.nullable() });
export type ArtifactCopyOrigin = z.infer<typeof artifactCopyOriginSchema>;
export type ArtifactCopyOriginResponse = z.infer<typeof artifactCopyOriginResponseSchema>;

/** Display metadata is not a filename and never changes immutable download metadata. */
export { artifactTitleSchema, artifactKindSchema, artifactLifecyclePayloads } from '../../domain/src/artifact-files.ts';
