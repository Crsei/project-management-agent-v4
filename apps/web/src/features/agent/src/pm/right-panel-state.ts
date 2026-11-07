/**
 * Surface tabs for the chat right panel. Files/Git and the shared terminal
 * manager are singletons; Browser can open additional independent tabs.
 */
export type PmRightPanelSurfaceKind = "files" | "git" | "terminal" | "browser";

export type PmRightPanelSurface = {
  id: string;
  kind: PmRightPanelSurfaceKind;
  /** One-based browser ordinal; singleton kinds omit it. */
  ordinal?: number;
  /** Live page title reported by the Browser surface. */
  title?: string;
};

export type PmRightPanelOrdinalKind = "browser";

export type PmRightPanelState = {
  surfaces: readonly PmRightPanelSurface[];
  activeId: string | null;
  nextOrdinal: Readonly<Record<PmRightPanelOrdinalKind, number>>;
};

export const EMPTY_RIGHT_PANEL_STATE: PmRightPanelState = {
  surfaces: [],
  activeId: null,
  nextOrdinal: { browser: 0 },
};

export type PmRightPanelAction =
  | { type: "add"; kind: PmRightPanelSurfaceKind }
  | { type: "activate"; id: string }
  | { type: "close"; id: string }
  | { type: "close-others"; id: string }
  | { type: "close-to-right"; id: string }
  | { type: "close-all" }
  | { type: "move"; id: string; toIndex: number }
  | { type: "title"; id: string; title: string };

const isOrdinalKind = (kind: PmRightPanelSurfaceKind): kind is PmRightPanelOrdinalKind =>
  kind === "browser";

function addSurface(state: PmRightPanelState, kind: PmRightPanelSurfaceKind): PmRightPanelState {
  if (!isOrdinalKind(kind)) {
    const existing = state.surfaces.find((surface) => surface.kind === kind);
    return existing ? { ...state, activeId: existing.id } : {
      ...state,
      surfaces: [...state.surfaces, { id: kind, kind }],
      activeId: kind,
    };
  }
  const ordinal = state.nextOrdinal[kind] + 1;
  const id = `${kind}:${ordinal}`;
  return {
    surfaces: [...state.surfaces, { id, kind, ordinal }],
    activeId: id,
    nextOrdinal: { ...state.nextOrdinal, [kind]: ordinal },
  };
}

function closeSurface(state: PmRightPanelState, id: string): PmRightPanelState {
  const index = state.surfaces.findIndex((surface) => surface.id === id);
  if (index < 0) return state;
  const surfaces = state.surfaces.filter((surface) => surface.id !== id);
  if (state.activeId !== id) return { ...state, surfaces };
  const neighbor = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
  return { ...state, surfaces, activeId: neighbor?.id ?? null };
}

export function pmRightPanelReducer(
  state: PmRightPanelState,
  action: PmRightPanelAction,
): PmRightPanelState {
  switch (action.type) {
    case "add":
      return addSurface(state, action.kind);
    case "activate":
      return state.surfaces.some((surface) => surface.id === action.id)
        ? { ...state, activeId: action.id }
        : state;
    case "close":
      return closeSurface(state, action.id);
    case "close-others": {
      const surface = state.surfaces.find((entry) => entry.id === action.id);
      return surface ? { ...state, surfaces: [surface], activeId: surface.id } : state;
    }
    case "close-to-right": {
      const index = state.surfaces.findIndex((surface) => surface.id === action.id);
      if (index < 0) return state;
      const surfaces = state.surfaces.slice(0, index + 1);
      const activeId = surfaces.some((surface) => surface.id === state.activeId)
        ? state.activeId
        : surfaces[index]!.id;
      return { ...state, surfaces, activeId };
    }
    case "close-all":
      return state.surfaces.length === 0 && state.activeId === null
        ? state
        : { ...state, surfaces: [], activeId: null };
    case "move": {
      const from = state.surfaces.findIndex((surface) => surface.id === action.id);
      if (from < 0) return state;
      const to = Math.max(0, Math.min(state.surfaces.length - 1, action.toIndex));
      if (from === to) return state;
      const surfaces = [...state.surfaces];
      const [surface] = surfaces.splice(from, 1);
      surfaces.splice(to, 0, surface!);
      return { ...state, surfaces };
    }
    case "title": {
      const title = action.title.trim().slice(0, 120);
      if (!title) return state;
      const current = state.surfaces.find((surface) => surface.id === action.id);
      if (!current || current.title === title) return state;
      return {
        ...state,
        surfaces: state.surfaces.map((surface) => surface.id === action.id ? { ...surface, title } : surface),
      };
    }
    default:
      return state;
  }
}

export function pmRightPanelSurfaceTitle(
  surface: PmRightPanelSurface,
  t: (zh: string, en: string) => string,
): string {
  switch (surface.kind) {
    case "files":
      return t("文件", "Files");
    case "git":
      return t("Git", "Git");
    case "browser":
      return surface.title?.trim() || t(`浏览器 ${surface.ordinal ?? 1}`, `Browser ${surface.ordinal ?? 1}`);
    case "terminal":
      return t("终端", "Terminals");
  }
}
