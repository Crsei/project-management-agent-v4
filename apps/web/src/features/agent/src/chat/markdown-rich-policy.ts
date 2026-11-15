export interface MarkdownNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: readonly MarkdownNode[];
}

export interface MarkdownTableData {
  headers: string[];
  rows: string[][];
}

export function markdownNodeText(node: MarkdownNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "br") return "\n";
  if (node.tagName === "img") return String(node.properties?.alt ?? "");
  // KaTeX's accessible annotation retains the formula without duplicating its visual glyphs.
  if (node.tagName === "math") {
    const findAnnotation = (part: MarkdownNode): MarkdownNode | undefined => {
      if (part.tagName === "annotation") return part;
      for (const child of part.children ?? []) {
        const annotation = findAnnotation(child);
        if (annotation) return annotation;
      }
      return undefined;
    };
    const annotation = findAnnotation(node);
    return annotation ? markdownNodeText(annotation) : "";
  }
  const classes = node.properties?.className;
  if (Array.isArray(classes) && classes.includes("katex-html")) return "";
  return node.children?.map(markdownNodeText).join("") ?? "";
}

export function markdownTableData(node: MarkdownNode): MarkdownTableData {
  const rows: string[][] = [];
  const visit = (part: MarkdownNode) => {
    if (part.tagName === "tr") {
      rows.push((part.children ?? [])
        .filter(child => child.tagName === "th" || child.tagName === "td")
        .map(markdownNodeText));
    } else {
      part.children?.forEach(visit);
    }
  };
  visit(node);
  return { headers: rows[0] ?? [], rows: rows.slice(1) };
}

export function markdownTableCsv({ headers, rows }: MarkdownTableData): string {
  const escape = (cell: string) => {
    // CSV quoting alone does not stop spreadsheet formula execution. Prefix the
    // original value, including any whitespace/control/format-character padding.
    const literal = /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(cell) ? `'${cell}` : cell;
    return /[",\r\n]/.test(literal) ? `"${literal.replaceAll('"', '""')}"` : literal;
  };
  return [headers, ...rows].map(row => row.map(escape).join(",")).join("\r\n");
}

export function markdownTableMarkdown({ headers, rows }: MarkdownTableData): string {
  const escape = (cell: string) => cell.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
  const row = (cells: string[]) => `| ${cells.map(escape).join(" | ")} |`;
  return [row(headers), row(headers.map(() => "---")), ...rows.map(row)].join("\n");
}

export function markdownMermaidError(source: string): string | undefined {
  if (source.length > 50_000) return "Diagram source exceeds the 50,000 character limit.";
  if (/%%\s*\{|^\s*---|@\s*\{|(?:^|[;\n])\s*(?:click|classDef|linkStyle|style)\s|<\/?[a-z!]|!\[|\b(?:img|image|icon)\s*:|\burl\s*\(|[a-z][a-z\d+.-]*:\/\/|\bdata:|\\/im.test(source)) {
    return "Diagram configuration, HTML, external assets, custom styles and interactive actions are disabled.";
  }
  return undefined;
}

export type MarkdownMediaKind = "image" | "audio" | "video";

/** A filename can offer a preview action, but only the authorized response selects its MIME. */
export function markdownMediaCandidate(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|avif|mp3|m4a|oga|ogg|wav|webm|flac|mp4|m4v|ogv)$/i.test(path);
}

export function markdownMediaKind(contentType: string): MarkdownMediaKind | undefined {
  const type = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(type ?? "")) return "image";
  if (["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/flac"].includes(type ?? "")) return "audio";
  if (["video/mp4", "video/webm", "video/ogg"].includes(type ?? "")) return "video";
  return undefined;
}
