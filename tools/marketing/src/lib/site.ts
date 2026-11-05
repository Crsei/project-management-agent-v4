const defaultAppUrl = "http://127.0.0.1:3224/pm";

function publicUrl(value: string | undefined, httpsOnly = false): URL | undefined {
  if (!value?.trim()) return undefined;

  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return undefined;
    if (url.protocol !== "https:" && (httpsOnly || url.protocol !== "http:")) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

// PUBLIC_APP_URL is the current name. PUBLIC_WORKSPACE_URL stays supported so
// an existing deployment does not break while it points at the unified /pm app.
const configuredAppUrl =
  import.meta.env.PUBLIC_APP_URL?.trim() || import.meta.env.PUBLIC_WORKSPACE_URL?.trim();
const app = publicUrl(configuredAppUrl || defaultAppUrl);

if (!app) {
  throw new Error(
    "PUBLIC_APP_URL (or PUBLIC_WORKSPACE_URL) must be an absolute HTTP(S) URL without embedded credentials.",
  );
}

export const appUrl = app.href;
export const appIsLocal = ["localhost", "127.0.0.1", "[::1]"].includes(app.hostname);
export const appLabel = appIsLocal ? "打开本地工作台" : "打开工作台";
export const appNote = appIsLocal
  ? `在本机打开 ${appUrl}。请先启动 v4 服务组，并使用 .local/access.json 中的账号登录。`
  : `打开已配置的工作台 ${app.origin}。营销站本身不执行 Agent。`;

export const agentWorkspaceUrl = new URL("/agent/workspace", app).href;

// Backwards-compatible exports for the older guide pages.
export const workspaceUrl = appUrl;
export const workspaceIsLocal = appIsLocal;
export const workspaceLabel = appLabel;
export const workspaceNote = appNote;

// Public, build-time links only. Never put access tokens or provider keys here.
export const desktopReleaseUrl = publicUrl(import.meta.env.PUBLIC_DESKTOP_RELEASE_URL, true)?.href;

export const sourceUrl = publicUrl(import.meta.env.PUBLIC_SOURCE_URL, true)?.href;
