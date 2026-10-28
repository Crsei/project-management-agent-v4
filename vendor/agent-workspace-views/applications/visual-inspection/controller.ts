import {
  regionFixtures,
  regionSuggestions,
  type Bounds,
  type Region,
  type ReviewImage,
} from "./fixtures.ts"
export type InspectionState = {
  images: ReviewImage[]
  imageId: string
  selectedId: string
  filter: "all" | "open" | "resolved"
  mode: "select" | "draw"
  zoom: number
  coordinatesOpen: boolean
  nextRegion: number
  nextNote: number
  dataState: "ready" | "loading" | "refresh-error"
  readonly: boolean
}
export function createInspectionState(
  scenario: string,
  src: string,
): InspectionState {
  const regions = structuredClone(regionFixtures)
  if (scenario === "long-content") {
    regions[1].title = {
      "zh-CN":
        "让商品明细易于浏览：在批发订单、多币种税额和需要特别关注的履约异常下保留完整的商品上下文",
      en: "Keep line items easy to scan across wholesale orders, multi-currency tax calculations, and fulfillment exceptions that need special attention",
    }
    regions[0].notes.push(
      ...Array.from({ length: 12 }, (_, i) => ({
        id: "long-" + i,
        kind: "review" as const,
        text: {
          "zh-CN":
            "审阅记录 " +
            (i + 1) +
            "：金额、税额与操作上下文应保持可见，不以截断代替详情。",
          en:
            "Review record " +
            (i + 1) +
            ": Keep amounts, tax, and action context visible; do not substitute truncation for the details.",
        },
      })),
    )
  }
  return {
    images:
      scenario === "empty"
        ? []
        : [
            {
              id: "order-detail",
              name: {
                "zh-CN": "订单详情 · 桌面",
                en: "Order detail · desktop",
              },
              src,
              width: 1452,
              height: 900,
              regions,
            },
          ],
    imageId: scenario === "empty" ? "" : "order-detail",
    selectedId: scenario === "empty" ? "" : "region-1",
    filter: "all",
    mode: "select",
    zoom: 100,
    coordinatesOpen: false,
    nextRegion: 4,
    nextNote: 20,
    dataState:
      scenario === "loading"
        ? "loading"
        : scenario === "refresh-error"
          ? "refresh-error"
          : "ready",
    readonly: scenario === "readonly",
  }
}
export function currentImage(state: InspectionState) {
  return state.images.find((image) => image.id === state.imageId)
}
export function selectedRegion(state: InspectionState) {
  return currentImage(state)?.regions.find(
    (region) => region.id === state.selectedId,
  )
}
export function visibleRegions(state: InspectionState) {
  return (currentImage(state)?.regions ?? []).filter(
    (region) =>
      state.filter === "all" ||
      (state.filter === "resolved") === region.resolved,
  )
}
const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n))
export function normalizeBounds(bounds: Bounds): Bounds {
  const x = clamp(Number.isFinite(bounds.x) ? bounds.x : 0, 0, 98),
    y = clamp(Number.isFinite(bounds.y) ? bounds.y : 0, 0, 98)
  return {
    x,
    y,
    width: clamp(Number.isFinite(bounds.width) ? bounds.width : 2, 2, 100 - x),
    height: clamp(
      Number.isFinite(bounds.height) ? bounds.height : 2,
      2,
      100 - y,
    ),
  }
}
export type InspectionAction =
  | { type: "select"; id: string }
  | { type: "filter"; filter: InspectionState["filter"] }
  | { type: "mode"; mode: InspectionState["mode"] }
  | { type: "zoom"; value: number }
  | { type: "coordinates"; open: boolean }
  | { type: "image"; id: string }
  | { type: "add"; bounds?: Bounds }
  | { type: "remove"; id: string }
  | { type: "resolve" }
  | { type: "title"; value: string }
  | { type: "draft"; value: string }
  | { type: "note" }
  | { type: "suggest" }
  | { type: "review" }
  | { type: "bounds"; bounds: Bounds }
  | { type: "upload"; image: ReviewImage }
  | { type: "load" }
export function inspectionTransition(
  state: InspectionState,
  action: InspectionAction,
): InspectionState {
  if (action.type === "filter") return { ...state, filter: action.filter }
  if (action.type === "zoom")
    return { ...state, zoom: clamp(action.value, 25, 200) }
  if (action.type === "coordinates")
    return { ...state, coordinatesOpen: action.open }
  if (action.type === "select")
    return currentImage(state)?.regions.some((r) => r.id === action.id)
      ? { ...state, selectedId: action.id }
      : state
  if (action.type === "image")
    return state.images.some((i) => i.id === action.id)
      ? {
          ...state,
          imageId: action.id,
          selectedId:
            state.images.find((i) => i.id === action.id)?.regions[0]?.id ?? "",
          zoom: 100,
          mode: "select",
        }
      : state
  if (action.type === "load") return { ...state, dataState: "ready" }
  if (state.readonly || state.dataState === "loading") return state
  if (action.type === "mode") return { ...state, mode: action.mode }
  if (action.type === "upload")
    return {
      ...state,
      images: [...state.images, action.image],
      imageId: action.image.id,
      selectedId: "",
      zoom: 100,
      mode: "select",
    }
  const image = currentImage(state)
  if (!image) return state
  const update = (regions: Region[], extra: Partial<InspectionState> = {}) => ({
    ...state,
    ...extra,
    images: state.images.map((i) =>
      i.id === image.id ? { ...i, regions } : i,
    ),
  })
  if (action.type === "add") {
    const n = state.nextRegion,
      id = "region-" + n
    return update(
      [
        ...image.regions,
        {
          id,
          number: n,
          title: { "zh-CN": "新区域 " + n, en: "New region " + n },
          resolved: false,
          bounds: normalizeBounds(
            action.bounds ?? { x: 25, y: 25, width: 30, height: 25 },
          ),
          notes: [],
          draft: "",
        },
      ],
      { selectedId: id, nextRegion: n + 1, filter: "all", mode: "select" },
    )
  }
  if (action.type === "remove") {
    const regions = image.regions.filter((r) => r.id !== action.id)
    return update(regions, {
      selectedId:
        state.selectedId === action.id
          ? (regions[0]?.id ?? "")
          : state.selectedId,
    })
  }
  if (action.type === "review") {
    if (!image.regions.length)
      return inspectionTransition(
        inspectionTransition(state, { type: "add" }),
        { type: "review" },
      )
    return update(
      image.regions.map((r, i) => ({
        ...r,
        notes: [
          ...r.notes,
          {
            id: "note-" + (state.nextNote + i),
            kind: "review",
            text: regionSuggestions[(r.number - 1) % 3],
          },
        ],
      })),
      { nextNote: state.nextNote + image.regions.length },
    )
  }
  const selected = selectedRegion(state)
  if (!selected) return state
  let next = selected,
    nextNote = state.nextNote
  switch (action.type) {
    case "resolve":
      next = { ...selected, resolved: !selected.resolved }
      break
    case "title":
      next = { ...selected, title: { "zh-CN": action.value, en: action.value } }
      break
    case "draft":
      next = { ...selected, draft: action.value }
      break
    case "bounds":
      next = { ...selected, bounds: normalizeBounds(action.bounds) }
      break
    case "note":
      if (!selected.draft.trim()) return state
      next = {
        ...selected,
        draft: "",
        notes: [
          ...selected.notes,
          {
            id: "note-" + nextNote++,
            kind: "user",
            text: { "zh-CN": selected.draft.trim(), en: selected.draft.trim() },
          },
        ],
      }
      break
    case "suggest":
      next = {
        ...selected,
        notes: [
          ...selected.notes,
          {
            id: "note-" + nextNote++,
            kind: "draft",
            text: regionSuggestions[(selected.number - 1) % 3],
          },
        ],
      }
      break
    default:
      return state
  }
  return update(
    image.regions.map((r) => (r.id === selected.id ? next : r)),
    { nextNote },
  )
}
export function exportInspection(state: InspectionState) {
  const image = currentImage(state)
  return JSON.stringify(
    {
      schemaVersion: 1,
      source: "local-fixture-review",
      image: image
        ? {
            id: image.id,
            name: image.name,
            width: image.width,
            height: image.height,
          }
        : null,
      regions:
        image?.regions.map((region) => ({
          id: region.id,
          number: region.number,
          title: region.title,
          resolved: region.resolved,
          bounds: region.bounds,
          notes: region.notes,
        })) ?? [],
    },
    null,
    2,
  )
}
