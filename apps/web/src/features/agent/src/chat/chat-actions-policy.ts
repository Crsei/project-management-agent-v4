/** A chat link is a workspace path, never a URL or a path outside this execution. */
export function normalizeChatFilePath(path: string, executionPath: string): string | null {
  // oxlint-disable-next-line no-control-regex -- workspace links reject path controls.
  if (!executionPath.startsWith("/") || !path || path.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path)) return null;
  const root = executionPath.replace(/\/+$/, "") || "/";
  let relative = path;
  if (relative.startsWith("/")) {
    if (root !== "/" && !relative.startsWith(`${root}/`)) return null;
    relative = relative.slice(root === "/" ? 1 : root.length + 1);
  }
  const parts = relative.split("/");
  if (parts.some((part) => part === "..")) return null;
  const normalized = parts.filter((part) => part && part !== ".").join("/");
  return normalized || null;
}
