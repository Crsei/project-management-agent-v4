import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { Actor } from '../../domain/src/core.ts';
import type { ArtifactCopyOriginResponse } from '../../contracts/src/artifact-files.ts';
import { getMembership, requireCapability } from './access.ts';
import type { CoreAccess } from './ports.ts';

/** No negative/source-presence signal is exposed to a target-only reader. */
export async function readArtifactCopyOrigin(pool: Pool, actor: Actor, workspaceId: string, versionId: string, core: () => Promise<CoreAccess>): Promise<ArtifactCopyOriginResponse> {
  workspaceId = z.uuid().toLowerCase().parse(workspaceId);
  versionId = z.uuid().toLowerCase().parse(versionId);
  const sql = await pool.connect();
  try {
    await sql.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await getMembership(sql, actor, workspaceId);
    const target = await sql.query<{ project_id: string }>(`SELECT v.project_id FROM entities v JOIN entities a
      ON a.workspace_id=v.workspace_id AND a.id::text=v.data->>'artifactId' AND a.kind='artifact' AND a.project_id=v.project_id
      WHERE v.workspace_id=$1 AND v.id=$2 AND v.kind='artifact_version'`, [workspaceId, versionId]);
    if (!target.rows[0]) throw new DomainError('not_found_or_forbidden', 'Artifact version is not accessible', 404);
    await requireCapability(sql, actor, workspaceId, 'domain.read', target.rows[0].project_id);
    const result = await sql.query<{ source_project_id: string; source_artifact_id: string; source_artifact_version_id: string; copied_at: Date }>(
      'SELECT source_project_id,source_artifact_id,source_artifact_version_id,copied_at FROM artifact_copy_origins WHERE workspace_id=$1 AND target_artifact_version_id=$2', [workspaceId, versionId]);
    const row = result.rows[0];
    let origin: ArtifactCopyOriginResponse['origin'] = null;
    if (row) {
      try {
        await requireCapability(sql, actor, workspaceId, 'domain.read', row.source_project_id);
        // A deleted/unavailable Markdown source project is indistinguishable from
        // no provenance. Archived readable history is deliberately permitted.
        await (await core()).get(row.source_project_id, 'project');
        origin = { sourceProjectId: row.source_project_id, sourceArtifactId: row.source_artifact_id, sourceArtifactVersionId: row.source_artifact_version_id, copiedAt: row.copied_at.toISOString() };
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        if (![403, 404, 409, 503].includes(error.status)) throw error;
      }
    }
    await sql.query('COMMIT');
    return { origin };
  } catch (error) { await sql.query('ROLLBACK'); throw error; }
  finally { sql.release(); }
}
