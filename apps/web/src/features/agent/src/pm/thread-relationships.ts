/**
 * Session lineage for the details panel.
 *
 * The only relationship the server records is `custom.parentThreadId`; this
 * module never derives forks from titles, timestamps or message content.
 */

export type RelationshipThread = {
  id: string;
  title?: string | null;
  parentThreadId?: string | null;
};

export type ThreadRelation = {
  id: string;
  title?: string;
  /** True when the related Session is referenced but not in the loaded list. */
  missing?: true;
  relation: "parent" | "fork";
};

export type ThreadRelationships = {
  parent?: ThreadRelation;
  children: ThreadRelation[];
};

function cleanTitle(title: string | null | undefined): string | undefined {
  const value = title?.trim();
  return value ? value : undefined;
}

export function buildThreadRelationships(
  threadId: string,
  threads: ReadonlyArray<RelationshipThread>,
): ThreadRelationships {
  if (!threadId) return { children: [] };
  const byId = new Map<string, RelationshipThread>();
  for (const thread of threads) {
    if (!byId.has(thread.id)) byId.set(thread.id, thread);
  }
  const parentId = byId.get(threadId)?.parentThreadId?.trim();
  const parent = parentId && parentId !== threadId
    ? (() => {
        const related = byId.get(parentId);
        if (!related) return { id: parentId, relation: "parent" as const, missing: true as const };
        const title = cleanTitle(related.title);
        return { id: related.id, relation: "parent" as const, ...(title ? { title } : {}) };
      })()
    : undefined;
  const seen = new Set<string>([threadId]);
  const children: ThreadRelation[] = [];
  for (const thread of threads) {
    if (thread.id === threadId || thread.parentThreadId?.trim() !== threadId || seen.has(thread.id)) continue;
    seen.add(thread.id);
    const title = cleanTitle(thread.title);
    children.push({ id: thread.id, relation: "fork", ...(title ? { title } : {}) });
  }
  children.sort((left, right) => (left.title ?? left.id).localeCompare(right.title ?? right.id));
  return { ...(parent ? { parent } : {}), children };
}
