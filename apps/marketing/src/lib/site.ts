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

const app = publicUrl(import.meta.env.PUBLIC_APP_URL?.trim() || defaultAppUrl);

if (!app) {
  throw new Error(
    "PUBLIC_APP_URL must be an absolute HTTP(S) URL without embedded credentials.",
  );
}

export const appUrl = app.href;
export const appIsLocal = ["localhost", "127.0.0.1", "[::1]"].includes(app.hostname);
export const appLabel = appIsLocal ? "打开本地工作台" : "打开工作台";
export const appNote = appIsLocal
  ? `在本机打开 ${appUrl}。先启动 v4 服务；新安装通过一次性设置令牌建号，已有实例使用原账号登录。`
  : `打开已配置的工作台 ${app.origin}。宣传站不执行 Agent；工作台不适合直接开放公网。`;

export const agentWorkspaceUrl = new URL("/agent/workspace", app).href;

// Public, build-time links only. Never put access tokens or provider keys here.
export const desktopReleaseUrl = publicUrl(import.meta.env.PUBLIC_DESKTOP_RELEASE_URL, true)?.href;

export const sourceUrl = publicUrl(
  import.meta.env.PUBLIC_SOURCE_URL?.trim() || "https://github.com/Crsei/project-management-agent-v4",
  true,
)?.href;
