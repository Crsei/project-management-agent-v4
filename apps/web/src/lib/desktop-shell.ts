type DesktopPlatform = "darwin" | "win32" | "linux";

type DesktopShellBridge = {
  readonly platform: DesktopPlatform;
  readonly titlebarHeight: number;
  setTitlebarTheme(theme: "light" | "dark"): Promise<void>;
};

declare global {
  interface Window {
    desktopShell?: DesktopShellBridge;
  }
}

function isDesktopPlatform(value: unknown): value is DesktopPlatform {
  return value === "darwin" || value === "win32" || value === "linux";
}

function desktopShell(): DesktopShellBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.desktopShell;
  return bridge && isDesktopPlatform(bridge.platform) ? bridge : null;
}

/**
 * Desktop-only window chrome bootstrap. CSS keys off the `data-desktop-shell`
 * attribute and this observer keeps the native caption symbols aligned with
 * the app theme. Browser builds never receive the bridge and stay unchanged.
 */
export function installDesktopShell(): () => void {
  const bridge = desktopShell();
  if (!bridge) return () => {};
  const root = document.documentElement;
  root.dataset.desktopShell = bridge.platform;
  root.style.setProperty("--desktop-titlebar-height", `${bridge.titlebarHeight}px`);

  let applied: "light" | "dark" | null = null;
  const syncTheme = () => {
    const theme = root.classList.contains("dark") ? "dark" : "light";
    if (theme === applied) return;
    applied = theme;
    void bridge.setTitlebarTheme(theme).catch(() => {
      /* Theme switching stays usable when the native window is already closing. */
    });
  };
  syncTheme();
  const observer = new MutationObserver(syncTheme);
  observer.observe(root, { attributes: true, attributeFilter: ["class"] });

  return () => {
    observer.disconnect();
    delete root.dataset.desktopShell;
    root.style.removeProperty("--desktop-titlebar-height");
  };
}
