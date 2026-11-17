export function fenceTitleFromMeta(meta: string | null | undefined): string | undefined {
  if (!meta) return undefined;
  const match = /(?:^|\s)title=(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(meta);
  const value = (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
  return value ? value.slice(0, 200) : undefined;
}

type MdNode = { type?: string; meta?: string | null; data?: { hProperties?: Record<string, unknown> }; children?: MdNode[] };

/** Copy an explicit fence title into the code element; no other meta is interpreted. */
export function remarkFenceTitle() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (node.type === "code") {
        const title = fenceTitleFromMeta(node.meta);
        if (title) {
          node.data ??= {};
          node.data.hProperties ??= {};
          node.data.hProperties["data-fence-title"] = title;
        }
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}
