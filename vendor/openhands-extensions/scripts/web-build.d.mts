/** Structurally compatible with Vite Plugin; no tooling-only runtime dependency. */
export declare function openHandsProvenancePlugin(): { name: string; apply: "build"; enforce: "post" };
export declare function verifyWebDistribution(directory: string, root?: string): Promise<{
  inventory: { version: number; outputInventorySha256: string; files: Array<{ path: string; sha256: string; bytes: number }> };
  sha256: string;
  outputInventorySha256: string;
}>;
