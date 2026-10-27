import type { DashboardRecord } from './dashboard.ts';

export type ProjectFavoriteData = { favorite: boolean };
export type ProjectFavorite = DashboardRecord<ProjectFavoriteData>;
/** Personal workspace navigation only; IDs are filtered against current authorized active projects on read. */
export type ProjectSidebarOrderData = { projectIds: string[] };
export type ProjectSidebarOrder = DashboardRecord<ProjectSidebarOrderData>;
export type ProjectCoverMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
/** An immutable registered version, never a storage key or client-supplied URL. */
export type ProjectCoverData = { artifactVersionId: string | null; mediaType: ProjectCoverMediaType | null };
export type ProjectCover = DashboardRecord<ProjectCoverData>;
export type ProjectScopeItem = { id: string; text: string; completed: boolean };
/** PM collaboration annotations, not Markdown scope or acceptance criteria. */
export type ProjectScopeData = { items: ProjectScopeItem[] };
export type ProjectScope = DashboardRecord<ProjectScopeData>;
export type ProjectExtrasProject = {
  projectId: string;
  favorite: ProjectFavorite | null;
  cover: ProjectCover | null;
  scope: ProjectScope | null;
};
export type ProjectExtras = { projects: ProjectExtrasProject[]; sidebarOrder: ProjectSidebarOrder | null };

/** Preserve saved neighbors, drop unavailable IDs, and append newly visible IDs deterministically. */
export function projectSidebarOrderIds(saved: readonly string[], authorizedActiveIds: readonly string[]): string[] {
  const remaining = new Set(authorizedActiveIds);
  const result: string[] = [];
  for (const id of saved) {
    if (remaining.delete(id)) result.push(id);
  }
  return [...result, ...[...remaining].sort()];
}

/** Return no change at either boundary or for a project outside the full authorized order. */
export function moveProjectSidebarOrderIds(ids: readonly string[], projectId: string, direction: 'up' | 'down'): string[] | null {
  const index = ids.indexOf(projectId);
  const neighbor = index + (direction === 'up' ? -1 : 1);
  if (index < 0 || neighbor < 0 || neighbor >= ids.length) return null;
  const moved = [...ids];
  [moved[index], moved[neighbor]] = [moved[neighbor]!, moved[index]!];
  return moved;
}

export function isProjectCoverMediaType(value: unknown): value is ProjectCoverMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/gif' || value === 'image/webp';
}

/** Reject declared-image HTML/SVG before associating or displaying uploaded bytes. */
export function isProjectCoverRaster(bytes: Uint8Array, mediaType: ProjectCoverMediaType): boolean {
  const matches = (offset: number, signature: readonly number[]) => signature.every((byte, index) => bytes[offset + index] === byte);
  const u32 = (offset: number) => ((bytes[offset] ?? 0) * 0x1000000 + (bytes[offset + 1] ?? 0) * 0x10000 + (bytes[offset + 2] ?? 0) * 0x100 + (bytes[offset + 3] ?? 0));
  switch (mediaType) {
    case 'image/png':
      return bytes.length >= 45 && matches(0, [137, 80, 78, 71, 13, 10, 26, 10])
        && u32(8) === 13 && matches(12, [73, 72, 68, 82]) && u32(16) > 0 && u32(20) > 0
        && u32(bytes.length - 12) === 0 && matches(bytes.length - 8, [73, 69, 78, 68]);
    case 'image/jpeg':
      return bytes.length >= 4 && matches(0, [255, 216, 255]) && matches(bytes.length - 2, [255, 217]);
    case 'image/gif':
      return bytes.length >= 14 && (matches(0, [71, 73, 70, 56, 55, 97]) || matches(0, [71, 73, 70, 56, 57, 97]))
        && ((bytes[6] ?? 0) + (bytes[7] ?? 0) * 256) > 0 && ((bytes[8] ?? 0) + (bytes[9] ?? 0) * 256) > 0 && bytes[bytes.length - 1] === 59;
    case 'image/webp': {
      const length = (bytes[4] ?? 0) + (bytes[5] ?? 0) * 256 + (bytes[6] ?? 0) * 65536 + (bytes[7] ?? 0) * 16777216;
      return bytes.length >= 20 && matches(0, [82, 73, 70, 70]) && length + 8 === bytes.length && matches(8, [87, 69, 66, 80])
        && (matches(12, [86, 80, 56, 32]) || matches(12, [86, 80, 56, 76]) || matches(12, [86, 80, 56, 88]));
    }
  }
}
