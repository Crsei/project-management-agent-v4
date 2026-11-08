/**
 * Typed boundary for the Electron workspace preload. The web build has no
 * bridge; the browser panel then keeps using the sandboxed iframe runtime.
 */
export type PreviewNavStatus =
  | { kind: "idle" }
  | { kind: "loading"; url: string }
  | { kind: "success"; url: string; title: string }
  | { kind: "failed"; url: string; code: number; description: string };

export type PreviewState = {
  tabId: string;
  partition: string;
  url: string | null;
  navStatus: PreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  title: string;
  faviconUrl: string;
  loading: boolean;
};

export type PreviewCapture = { dataUrl: string; width: number; height: number };

export type PreviewPickedElement = {
  dataUrl: string;
  width: number;
  height: number;
  url: string;
  title: string;
  selector: string;
  tagName: string;
  text: string;
  screenshotFailed: boolean;
};

export type PreviewOpenLink = { tabId: string; url: string };

export type DesktopDirectoryBridge = { choose: () => Promise<string | null> };

export type DesktopPreviewBridge = {
  state: (tabId: string) => Promise<PreviewState | null>;
  createTab: (tabId: string, options?: { url?: string }) => Promise<{ partition: string; preload: string; state: PreviewState }>;
  closeTab: (tabId: string) => Promise<{ closed: true }>;
  registerWebview: (tabId: string, webContentsId: number) => Promise<PreviewState>;
  navigate: (tabId: string, url: string) => Promise<PreviewState>;
  back: (tabId: string) => Promise<PreviewState | null>;
  forward: (tabId: string) => Promise<PreviewState | null>;
  reload: (tabId: string) => Promise<PreviewState | null>;
  stop: (tabId: string) => Promise<PreviewState | null>;
  capture: (tabId: string) => Promise<PreviewCapture>;
  pick: (tabId: string) => Promise<PreviewPickedElement | { cancelled: true }>;
  cancelPick: (tabId: string) => Promise<{ cancelled: true }>;
  openPiP: (tabId: string) => Promise<{ open: true }>;
  closePiP: (tabId: string) => Promise<{ open: false }>;
  openDevTools: (tabId: string) => Promise<{ open: true }>;
  openExternal: (url: string) => Promise<{ opened: boolean }>;
  onState: (listener: (state: PreviewState) => void) => () => void;
  onOpenLink: (listener: (event: PreviewOpenLink) => void) => () => void;
};

export type ElectronWebviewElement = HTMLElement & {
  src: string;
  partition: string;
  getWebContentsId: () => number;
  reload: () => void;
  stop: () => void;
  focus: () => void;
};

declare global {
  interface Window {
    desktopWorkspace?: {
      preview?: DesktopPreviewBridge;
      directories?: DesktopDirectoryBridge;
    };
  }
}

export function desktopPreviewBridge(): DesktopPreviewBridge | null {
  return typeof window === "undefined" ? null : window.desktopWorkspace?.preview ?? null;
}

export function desktopDirectoryBridge(): DesktopDirectoryBridge | null {
  return typeof window === "undefined" ? null : window.desktopWorkspace?.directories ?? null;
}
