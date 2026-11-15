import type { NativeOutputItem } from "@agent-workspace/contracts/output";

/** Preserve provider text verbatim; only synthesize Markdown from explicit steps. */
export function planMarkdown(item: NativeOutputItem): string {
  if (item.text?.trim()) return item.text;
  return (item.steps ?? []).map(step => `- [${step.status === "completed" ? "x" : " "}] ${step.text}`).join("\n");
}

export function planFilename(item: NativeOutputItem): string {
  const title = item.title?.trim() || item.text?.split(/\r?\n/u).find(line => /^#{1,6}\s+\S/u.test(line))?.replace(/^#{1,6}\s+/u, "") || "proposed-plan";
  const base = title.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-.]+|[-.]+$/gu, "").slice(0, 80);
  return `${base || "proposed-plan"}.md`;
}
