import type { Entity } from "../../../../../../../packages/contracts/src/client.ts"
import type { FilterCondition } from "../../../../components/blocks/filter-card"

export type FileKind = "fig" | "pdf" | "zip" | "img" | "sheet" | "doc" | "code" | "other"
export type FileSort = "newest" | "name" | "type"
export type FileView = "grid" | "list"

export const filterFileKinds: readonly FileKind[] = ["fig", "pdf", "zip", "img", "sheet", "doc", "code"]
export const allFileKinds: readonly FileKind[] = [...filterFileKinds, "other"]

const kindLabels: Record<FileKind, readonly [string, string]> = {
  fig: ["Figma", "Figma"],
  pdf: ["PDF", "PDF"],
  zip: ["压缩包", "Archive"],
  img: ["图片", "Image"],
  sheet: ["表格", "Spreadsheet"],
  doc: ["文档", "Document"],
  code: ["代码", "Code"],
  other: ["文件", "File"],
}

const extensions: Record<FileKind, readonly string[]> = {
  fig: ["fig"],
  pdf: ["pdf"],
  zip: ["zip", "rar", "7z", "tar", "gz"],
  img: ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "avif", "bmp", "tif", "tiff"],
  sheet: ["xlsx", "xls", "csv", "numbers", "ods"],
  doc: ["doc", "docx", "txt", "md", "pages", "rtf", "odt"],
  code: ["js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "html", "htm", "css", "scss", "py", "rb", "go", "rs", "java", "kt", "sh", "xml", "yaml", "yml", "sql"],
  other: [],
}

export type FileEntry = {
  id: string
  artifactId: string
  artifact: Entity
  hidden: boolean
  originalFileName: string
  name: string
  kind: FileKind
  mediaType: string
  size: number | null
  uploaderId: string
  updatedAt: string | null
  versions: Entity[]
  latest: Entity
  versionCount: number
}

export function fileProjectWritable(project: Entity): boolean {
  return project.data.archived !== true && !project.data.archivedAt && ["planning", "active"].includes(asString(project.data.status))
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function extensionOf(name: string): string {
  const trimmed = name.trim()
  const dot = trimmed.lastIndexOf(".")
  if (dot <= 0 || dot === trimmed.length - 1) return ""
  return trimmed.slice(dot + 1).toLowerCase()
}

export function classifyFile(name: string, mediaType = ""): FileKind {
  const ext = extensionOf(name)
  for (const kind of allFileKinds) {
    if (extensions[kind].includes(ext)) return kind
  }
  const media = mediaType.toLowerCase()
  if (media === "application/pdf") return "pdf"
  if (media.startsWith("image/")) return "img"
  if (media.startsWith("text/")) return media.includes("markdown") || media.includes("plain") ? "doc" : "code"
  if (media.includes("spreadsheet") || media.includes("csv")) return "sheet"
  if (media.includes("zip") || media.includes("compressed") || media.includes("archive")) return "zip"
  if (media.includes("json") || media.includes("javascript") || media.includes("xml") || media.includes("html") || media.includes("css")) return "code"
  if (media.includes("word") || media.includes("document") || media.includes("rtf")) return "doc"
  if (media.includes("figma")) return "fig"
  return "other"
}

export function artifactKindFor(kind: FileKind): string {
  return kind === "other" ? "file" : kind
}

export function kindLabel(kind: FileKind, en: boolean): string {
  return kindLabels[kind][en ? 1 : 0]
}

export function formatFileSize(size: unknown): string {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return ""
  if (size < 1024) return `${Math.round(size)} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/** Short, locale-aware relative time; falls back to a short date after a week. */
export function formatRelativeTime(value: string | null | undefined, locale: string, now = Date.now()): string {
  if (!value) return "—"
  const date = new Date(value)
  const time = date.getTime()
  if (!Number.isFinite(time)) return "—"
  const diff = time - now
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" })
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), "second")
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute")
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour")
  if (abs < 7 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), "day")
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(date)
}

/**
 * Files are artifacts. Every version stays addressable, but the page shows one
 * row per artifact (latest first) so a new version does not duplicate the file.
 */
export function buildFileEntries(artifacts: Entity[] | undefined, versions: Entity[] | undefined): FileEntry[] {
  const versionList = versions ?? []
  const artifactList = artifacts ?? []
  const versionById = new Map(versionList.map(version => [version.id, version]))
  const entries: FileEntry[] = []

  for (const artifact of artifactList) {
    const refs = Array.isArray(artifact.data.versionRefs)
      ? artifact.data.versionRefs.filter((value): value is string => typeof value === "string")
      : []
    const ordered: Entity[] = []
    for (const id of refs) {
      const version = versionById.get(id)
      if (version && !ordered.includes(version)) ordered.push(version)
    }
    for (const version of versionList) {
      if (asString(version.data.artifactId) === artifact.id && !ordered.includes(version)) ordered.push(version)
    }
    if (!ordered.length) continue
    const latestId = asString(artifact.data.latestVersionId)
    const latest = versionById.get(latestId) ?? ordered[ordered.length - 1]
    if (!latest) continue
    const rest = ordered
      .filter(version => version.id !== latest.id)
      .sort((a, b) => (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0))
    const versionsForEntry = [latest, ...rest]
    const name = asString(artifact.data.title)
    const originalFileName = asString(latest.data.fileName)
    const mediaType = asString(latest.data.mediaType)
    const size = typeof latest.data.size === "number" && Number.isFinite(latest.data.size) && latest.data.size >= 0 ? latest.data.size : null
    entries.push({
      id: artifact.id,
      artifactId: artifact.id,
      artifact,
      hidden: artifact.data.hiddenAt !== null,
      originalFileName,
      name,
      kind: classifyFile(originalFileName, mediaType),
      mediaType,
      size,
      uploaderId: asString(latest.data.producerId) || asString(latest.data.ownerId) || latest.createdBy,
      updatedAt: latest.createdAt ?? latest.updatedAt,
      versions: versionsForEntry,
      latest,
      versionCount: versionsForEntry.length,
    })
  }


  return entries.sort(newestFirstEntry)
}

function newestFirstEntry(a: FileEntry, b: FileEntry): number {
  return (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0)
}

export const fileFilterFieldIds = ["kind", "uploader", "updated"] as const
export type FileFilterFieldId = (typeof fileFilterFieldIds)[number]

/** `updated` condition values are rolling windows; `older` means outside the 30-day window. */
export const fileUpdatedValues = ["24h", "7d", "30d", "older"] as const
export type FileUpdatedValue = (typeof fileUpdatedValues)[number]

const updatedWindows: Record<Exclude<FileUpdatedValue, "older">, number> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
}

export function matchesUpdatedWindow(value: string | null | undefined, option: string, now = Date.now()): boolean {
  const time = value ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(time)) return false
  const age = Math.max(0, now - time)
  if (option === "older") return age > updatedWindows["30d"]
  if (option === "24h" || option === "7d" || option === "30d") return age <= updatedWindows[option]
  return false
}

function matchesCondition(entry: FileEntry, condition: FilterCondition, now: number): boolean {
  if (!condition.values.length) return true
  let matched: boolean
  if (condition.field === "kind") matched = condition.values.includes(entry.kind)
  else if (condition.field === "uploader") matched = condition.values.includes(entry.uploaderId)
  else if (condition.field === "updated") matched = condition.values.some(value => matchesUpdatedWindow(entry.updatedAt, value, now))
  else return true
  return condition.operator === "isNot" ? !matched : matched
}

/** Conditions are ANDed, values inside a condition are ORed, and empty value lists are ignored. */
export function filterAndSort(entries: readonly FileEntry[], query: string, conditions: readonly FilterCondition[], sort: FileSort, now = Date.now()): FileEntry[] {
  const needle = query.trim().toLocaleLowerCase()
  const active = conditions.filter(condition => condition.values.length > 0)
  const filtered = entries.filter(entry =>
    (!needle || entry.name.toLocaleLowerCase().includes(needle)) &&
    active.every(condition => matchesCondition(entry, condition, now)),
  )
  return [...filtered].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name)
    if (sort === "type") return a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
    return newestFirstEntry(a, b)
  })
}

/** Supports both artifact and version IDs in the `file` query parameter. */
export function entryForFile(entries: readonly FileEntry[], fileId: string): { entry: FileEntry; versionId: string } | null {
  for (const entry of entries) {
    if (entry.id === fileId) return { entry, versionId: entry.latest.id }
    const version = entry.versions.find(candidate => candidate.id === fileId)
    if (version) return { entry, versionId: version.id }
  }
  return null
}
