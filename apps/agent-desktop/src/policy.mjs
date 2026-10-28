import { isAbsolute } from "node:path";

export function remoteAddress(value) {
  if (typeof value !== "string" || value.length > 2048)
    throw new Error("Enter an http(s) workspace URL.");
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a complete URL, for example https://workspace.example.com.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(
      "Only http(s) URLs without embedded credentials are allowed. Sign in inside the workspace.",
    );
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new Error(
      "Remote workspaces require HTTPS. HTTP is allowed only for localhost, 127.0.0.1 or [::1].",
    );
  }
  if (url.search || url.hash)
    throw new Error("Remove URL query parameters and fragments; never pass credentials in a URL.");
  if (!["/", "/agent", "/agent/", "/agent/workspace", "/agent/workspace/"].includes(url.pathname)) {
    throw new Error("Use the v3 public origin or /agent/workspace URL.");
  }
  return `${url.origin}/agent/workspace`;
}

export function absolutePath(value, label) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("\0") ||
    !isAbsolute(value.trim())
  ) {
    throw new Error(`${label} must be an absolute filesystem path.`);
  }
  return value.trim();
}

export function readLaunchArguments(args) {
  const result = {};
  const names = new Map([
    ["--remote", "remoteUrl"],
    ["--data-dir", "dataDir"],
    ["--project-root", "projectRoot"],
    ["--node", "nodePath"],
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--local") {
      if (result.mode && result.mode !== "local")
        throw new Error("Choose either --local or --remote, not both.");
      result.mode = "local";
      continue;
    }
    const separator = arg.indexOf("=");
    const flag = separator < 0 ? arg : arg.slice(0, separator);
    if (!names.has(flag)) continue; // Electron and Chromium own their launch switches.
    const value = separator < 0 ? args[++i] : arg.slice(separator + 1);
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    const key = names.get(flag);
    result[key] = key === "remoteUrl" ? remoteAddress(value) : absolutePath(value, flag);
    if (key === "remoteUrl") {
      if (result.mode && result.mode !== "remote")
        throw new Error("Choose either --local or --remote, not both.");
      result.mode = "remote";
    }
  }
  return result;
}

export function sameService(value, expectedOrigin) {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.origin === expectedOrigin &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function serviceRequestAllowed(value, origin) {
  if (value.startsWith("data:") || value.startsWith("blob:")) return true;
  try {
    const url = new URL(value);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    return sameService(url.href, origin);
  } catch {
    return false;
  }
}
