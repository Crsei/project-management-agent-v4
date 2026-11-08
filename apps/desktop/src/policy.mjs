import { createHash } from "node:crypto";
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
  if (!["/", "/pm", "/pm/", "/agent", "/agent/", "/agent/workspace", "/agent/workspace/"].includes(url.pathname)) {
    throw new Error("Use the public origin, /pm or /agent/workspace URL.");
  }
  return `${url.origin}${url.pathname.startsWith("/agent") ? "/agent/workspace" : "/pm"}`;
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
  if (typeof value !== "string") return false;
  if (value.startsWith("data:")) return true;
  if (value.startsWith("blob:")) return sameService(value.slice(5), origin);
  try {
    const url = new URL(value);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    return sameService(url.href, origin);
  } catch {
    return false;
  }
}

// Only this allowlist may cross back into the renderer or connection.json.
export function publicConfiguration(value, allowNodeOverride = false) {
  return {
    mode: value.mode === "remote" ? "remote" : "local",
    remoteUrl: typeof value.remoteUrl === "string" ? value.remoteUrl : "",
    dataDir: typeof value.dataDir === "string" ? value.dataDir : "",
    projectRoot: typeof value.projectRoot === "string" ? value.projectRoot : "",
    ...(allowNodeOverride && typeof value.nodePath === "string" ? { nodePath: value.nodePath } : {}),
  };
}

export function initialSetup(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Enter the first local account details.");
  const { email, password, name, workspaceName } = value;
  if (typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
    throw new Error("Enter a valid email for the first local account.");
  if (typeof password !== "string" || password.length < 12 || password.length > 1024)
    throw new Error("The first account password must contain 12–1024 characters.");
  if (typeof name !== "string" || !name.trim() || name.trim().length > 120)
    throw new Error("Enter your name (up to 120 characters).");
  if (typeof workspaceName !== "string" || !workspaceName.trim() || workspaceName.trim().length > 120)
    throw new Error("Enter a workspace name (up to 120 characters).");
  return { email: email.trim(), password, name: name.trim(), workspaceName: workspaceName.trim() };
}

export function workspacePartition(mode, origin, instanceId) {
  if (!sameService(origin, origin) || new URL(origin).origin !== origin)
    throw new Error("The workspace did not return a valid public origin.");
  if (mode !== "local" && mode !== "remote") throw new Error("Invalid workspace mode.");
  if (mode === "local" && (typeof instanceId !== "string" || !instanceId.trim() || instanceId.length > 200))
    throw new Error("The local workspace identity is missing. Do not recreate or replace its data directory.");
  const identity = mode === "local" ? `${instanceId}\0${origin}` : origin;
  return `persist:${mode}-workspace-${createHash("sha256").update(identity).digest("hex")}`;
}

export function safeDesktopMessage(value, secrets = []) {
  let message = String(value instanceof Error ? value.message : value ?? "An unexpected desktop error occurred.");
  for (const secret of secrets)
    if (typeof secret === "string" && secret.length) message = message.split(secret).join("[redacted]");
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[private database connection]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|access_token|password|secret|authorization)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/((?:password|token|secret|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]")
    .slice(-12_000);
}

export function trustedConnectionFrame(event, contents, connectionUrl) {
  try {
    return Boolean(contents && !contents.isDestroyed() && event.sender === contents &&
      event.senderFrame === contents.mainFrame && event.senderFrame?.url === connectionUrl);
  } catch {
    return false; // Electron can invalidate a frame while its IPC request is queued.
  }
}

export function trustedWorkspaceFrame(event, contents, workspaceUrl) {
  try {
    return Boolean(contents && !contents.isDestroyed() && event.sender === contents &&
      event.senderFrame === contents.mainFrame && sameService(event.senderFrame?.url, new URL(workspaceUrl).origin));
  } catch {
    return false;
  }
}
