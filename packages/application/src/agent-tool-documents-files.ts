import { z } from 'zod';
import type { Capability } from '../../domain/src/core.ts';
import { documentSourceIdSchema } from '../../contracts/src/document-sources.ts';
import { artifactKindSchema, artifactTitleSchema } from '../../domain/src/artifact-files.ts';

const projectId = z.string().regex(/^PRJ-\d+$/);
const id = z.uuid().toLowerCase();
const version = z.number().int().positive();
const page = { after: z.string().min(1).max(2048).nullable().default(null), limit: z.number().int().min(1).max(100).default(30) };
const relativePath = z.string().min(1).max(4096).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => !part || part === '.' || part === '..') && /\.md$/i.test(value), 'Expected a relative Markdown path; native private-directory rules still apply');
const external = { sourceId: documentSourceIdSchema, sourceRevision: version, path: relativePath };
const existing = { ...external, expectedRevision: z.string().min(1).max(256) };
const artifactTarget = { projectId, artifactId: id, expectedVersion: version };
export const DocumentsFilesToolInputSchemas = {
  pm_list_document_sources: z.strictObject({ projectId: projectId.nullable().default(null), offset: z.number().int().min(0).max(1000000).default(0), limit: z.number().int().min(1).max(100).default(50) }),
  // Existing references only: directory selection and arbitrary host paths remain operator-only.
  pm_configure_document_sources: z.strictObject({ projectId: projectId.nullable(), expectedRevision: z.number().int().min(0).max(2147483646), sourceIds: z.array(documentSourceIdSchema).max(100).refine(values => new Set(values).size === values.length, 'Duplicate source references') }),
  pm_list_external_files: z.strictObject({ sourceId: documentSourceIdSchema, cursor: z.string().min(1).max(2048).nullable().default(null), limit: z.number().int().min(1).max(100).default(30) }),
  pm_read_external_file: z.strictObject({ sourceId: documentSourceIdSchema, path: relativePath, expectedRevision: z.string().min(1).max(256).nullable().default(null), contentOffset: z.number().int().min(0).max(4 * 1024 * 1024).default(0), contentLimit: z.number().int().min(1).max(24000).default(12000) }),
  pm_create_external_file: z.strictObject({ ...external, content: z.string().max(4 * 1024 * 1024) }),
  pm_save_external_file: z.strictObject({ ...existing, content: z.string().max(4 * 1024 * 1024) }),
  pm_rename_external_file: z.strictObject({ ...existing, targetPath: relativePath }),
  pm_move_external_file: z.strictObject({ ...existing, targetSourceId: documentSourceIdSchema, targetSourceRevision: version, targetPath: relativePath }),
  pm_delete_external_file: z.strictObject(existing),
  pm_external_file_result: z.strictObject({ sourceId: documentSourceIdSchema, operationId: id }),
  pm_list_uploads: z.strictObject({ projectId, ...page }),
  pm_read_upload: z.strictObject({ projectId, uploadId: id }),
  pm_list_artifacts: z.strictObject({ projectId, ...page, visibility: z.enum(['visible', 'hidden', 'all']).default('visible') }),
  pm_read_artifact: z.strictObject({ projectId, artifactId: id }),
  pm_list_artifact_versions: z.strictObject({ projectId, ...page, visibility: z.enum(['visible', 'hidden', 'all']).default('visible') }),
  pm_read_artifact_version: z.strictObject({ projectId, artifactVersionId: id }),
  pm_artifact_copy_origin: z.strictObject({ projectId, artifactVersionId: id }),
  pm_register_artifact: z.strictObject({ projectId, uploadId: id, uploadVersion: version, title: artifactTitleSchema, artifactKind: artifactKindSchema }),
  pm_add_artifact_version: z.strictObject({ ...artifactTarget, uploadId: id, uploadVersion: version }),
  pm_rename_artifact: z.strictObject({ ...artifactTarget, title: artifactTitleSchema }),
  pm_hide_artifact: z.strictObject(artifactTarget),
  pm_restore_artifact: z.strictObject(artifactTarget),
  pm_copy_artifact_version: z.strictObject({ projectId, projectVersion: version, sourceProjectId: projectId, sourceArtifactId: id, sourceArtifactVersion: version, artifactVersionId: id, artifactVersion: version, title: artifactTitleSchema, artifactKind: artifactKindSchema }),
} as const;

type Metadata = { description: string; write: boolean; capabilities: Capability[]; scope: 'project' | 'workspace' | 'workspace-admin' };
const read = ['domain.read'] satisfies Capability[];
const edit = ['domain.read', 'planning.edit'] satisfies Capability[];
const delivery = ['domain.read', 'delivery.write'] satisfies Capability[];
export const DocumentsFilesToolMetadata = {
  pm_list_document_sources: { description: 'List authorized external Markdown source associations and their separate association/source revisions; never host paths.', write: false, capabilities: read, scope: 'workspace' },
  pm_configure_document_sources: { description: 'CAS-replace source associations using existing authorized source references; an empty set unlinks without deleting disk files. New host directories require the operator CLI.', write: true, capabilities: ['domain.read', 'planning.edit', 'access.manage'], scope: 'workspace-admin' },
  pm_list_external_files: { description: 'Page an authorized external source with opaque file keys, scan completeness and issues.', write: false, capabilities: read, scope: 'workspace' },
  pm_read_external_file: { description: 'Read a bounded external Markdown body slice with independent file/source revisions. Bind later slices to expectedRevision.', write: false, capabilities: read, scope: 'workspace' },
  pm_create_external_file: { description: 'Create a new external Markdown file, never overwrite. The original tool operation ID is the native filesystem operation ID.', write: true, capabilities: edit, scope: 'workspace' },
  pm_save_external_file: { description: 'Save external Markdown against exact source and file revisions; reconcile the original operation after ambiguity.', write: true, capabilities: edit, scope: 'workspace' },
  pm_rename_external_file: { description: 'Rename external Markdown within the same pinned source without overwriting a destination.', write: true, capabilities: edit, scope: 'workspace' },
  pm_move_external_file: { description: 'Move between authorized pinned sources using both source revisions; a partial move remains unknown and is never retried or called rolled back.', write: true, capabilities: edit, scope: 'workspace' },
  pm_delete_external_file: { description: 'Delete external Markdown using exact revisions while retaining native authorized operation/history identity.', write: true, capabilities: edit, scope: 'workspace' },
  pm_external_file_result: { description: 'Reconcile only the original actor/source/filesystem operation; never resend, resume or compensate the write.', write: false, capabilities: edit, scope: 'workspace' },
  pm_list_uploads: { description: 'Page authorized staged-upload metadata; no host object paths, credentials or bytes.', write: false, capabilities: read, scope: 'project' },
  pm_read_upload: { description: 'Read an authorized staged upload reference, expiry, ownership, hash, size and consumption state.', write: false, capabilities: read, scope: 'project' },
  pm_list_artifacts: { description: 'Page artifacts with explicit visible/hidden/all lifecycle filtering.', write: false, capabilities: read, scope: 'project' },
  pm_read_artifact: { description: 'Read authorized artifact display metadata and immutable version references.', write: false, capabilities: read, scope: 'project' },
  pm_list_artifact_versions: { description: 'Page authorized immutable artifact-version metadata, hashes and authenticated relative download references; never bytes.', write: false, capabilities: read, scope: 'project' },
  pm_read_artifact_version: { description: 'Read an authorized immutable version and its authenticated download reference; downloads require normal PM authorization.', write: false, capabilities: read, scope: 'project' },
  pm_artifact_copy_origin: { description: 'Read copy provenance only while both source and target remain currently authorized; otherwise origin is redacted.', write: false, capabilities: read, scope: 'project' },
  pm_register_artifact: { description: 'Publish a real staged upload as an artifact and immutable version; exact upload CAS and owner/expiry checks apply.', write: true, capabilities: delivery, scope: 'project' },
  pm_add_artifact_version: { description: 'Consume an authorized staged upload into a new immutable artifact version using exact artifact/upload CAS.', write: true, capabilities: delivery, scope: 'project' },
  pm_rename_artifact: { description: 'Rename display metadata only; immutable download filenames, bytes, versions and Evidence remain unchanged.', write: true, capabilities: delivery, scope: 'project' },
  pm_hide_artifact: { description: 'Hide artifact listing metadata without deleting immutable versions or Evidence.', write: true, capabilities: delivery, scope: 'project' },
  pm_restore_artifact: { description: 'Restore the same hidden artifact identity using exact CAS.', write: true, capabilities: delivery, scope: 'project' },
  pm_copy_artifact_version: { description: 'Copy the explicitly selected immutable version into independent verified storage in an authorized target project; preserve source and Evidence.', write: true, capabilities: delivery, scope: 'project' },
} as const satisfies Record<keyof typeof DocumentsFilesToolInputSchemas, Metadata>;
