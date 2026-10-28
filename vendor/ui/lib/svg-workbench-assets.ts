import type { IconSource } from "./svg-workbench-model"
export type SvgIconAsset = {
  id: string
  name: string
  tags: string[]
  categories: string[]
  svg: string
  source: IconSource
  licenseText: string
  adaptations: string[]
}
export const svgCollections = [
  "lucide",
  "tabler",
  "phosphor",
  "simple-icons",
  "lobe",
  "iconify-lucide",
] as const
export type SvgCollection = (typeof svgCollections)[number]
export const loadSvgCollection = (
  collection: SvgCollection,
): Promise<SvgIconAsset[]> =>
  ({
    lucide: () => import("./svg-assets/lucide").then((m) => m.assets),
    tabler: () => import("./svg-assets/tabler").then((m) => m.assets),
    phosphor: () => import("./svg-assets/phosphor").then((m) => m.assets),
    "simple-icons": () =>
      import("./svg-assets/simple-icons").then((m) => m.assets),
    lobe: () => import("./svg-assets/lobe").then((m) => m.assets),
    "iconify-lucide": () =>
      import("./svg-assets/iconify-lucide").then((m) => m.assets),
  })[collection]()
