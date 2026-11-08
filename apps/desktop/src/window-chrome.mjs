// Native window chrome shared by the connection and workspace windows.
// The overlay background is transparent: the React/connection page paints it
// so the caption strip blends into both light and dark surfaces.
export const TITLEBAR_HEIGHT = 40;
export const MACOS_TITLEBAR_HEIGHT = 56;
const TITLEBAR_COLOR = "#01000000"; // #00000000 is not transparent on Linux.
const LIGHT_SYMBOL_COLOR = "#232322";
const DARK_SYMBOL_COLOR = "#ecece8";
const MACOS_WINDOW_BUTTON_RADIUS = 7;

export function normalizeTitleBarTheme(value) {
  return value === "dark" || value === "light" ? value : null;
}

export function titleBarOverlay(theme = "light") {
  const resolved = normalizeTitleBarTheme(theme) ?? "light";
  return {
    color: TITLEBAR_COLOR,
    height: TITLEBAR_HEIGHT,
    symbolColor: resolved === "dark" ? DARK_SYMBOL_COLOR : LIGHT_SYMBOL_COLOR,
  };
}

export function windowTitleBarOptions(platform, theme = "light") {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: macosWindowButtonPosition(1),
    };
  }
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: titleBarOverlay(theme),
  };
}

export function macosWindowButtonPosition(zoomFactor = 1) {
  const factor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return {
    x: 16,
    y: Math.round((MACOS_TITLEBAR_HEIGHT * factor) / 2 - MACOS_WINDOW_BUTTON_RADIUS),
  };
}
