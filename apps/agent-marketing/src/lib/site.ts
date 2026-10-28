const defaultWorkspaceUrl = "http://127.0.0.1:3223/agent/workspace";

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

const configuredWorkspaceUrl = import.meta.env.PUBLIC_WORKSPACE_URL?.trim();
const workspace = publicUrl(configuredWorkspaceUrl || defaultWorkspaceUrl);

if (!workspace) {
  throw new Error(
    "PUBLIC_WORKSPACE_URL must be an absolute HTTP(S) URL without embedded credentials.",
  );
}

export const workspaceUrl = workspace.href;
export const workspaceIsLocal = ["localhost", "127.0.0.1", "[::1]"].includes(workspace.hostname);
export const workspaceLabel = workspaceIsLocal ? "Open local workspace" : "Open workspace";
export const workspaceNote = workspaceIsLocal
  ? `Opens ${workspaceUrl} on this computer. Start your workspace server first.`
  : `Opens your configured workspace at ${workspace.origin}. This site does not run agents.`;

// Public, build-time links only. Never put access tokens or provider keys in these values.
export const desktopReleaseUrl = publicUrl(import.meta.env.PUBLIC_DESKTOP_RELEASE_URL, true)?.href;
