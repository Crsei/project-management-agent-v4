"use client"
import { useState, type Dispatch, type SetStateAction } from "react"
import { useThreadController, type ThreadController } from "./shared"
import type { ComposerDemoController } from "../demo-controller"
import {
  useResourcePanel,
  type ResourcePanelController,
} from "./resource-layout"
import type {
  ComponentRecord,
  Conversation18Fixture,
  Conversation18Scenario,
} from "./conversation-18-fixtures"

type InventorySort = { columnId: string; direction: "asc" | "desc" } | null
export interface Conversation18Controller
  extends ComposerDemoController, ThreadController, ResourcePanelController {
  rows: ComponentRecord[]
  filterText: string
  setFilterText: Dispatch<SetStateAction<string>>
  sort: InventorySort
  setSort: Dispatch<SetStateAction<InventorySort>>
  selectedRecords: string[]
  setSelectedRecords: Dispatch<SetStateAction<string[]>>
  hiddenColumns: string[]
  setHiddenColumns: Dispatch<SetStateAction<string[]>>
  widths: Record<string, number>
  setColumnWidth: (id: string, value: number) => void
  propertiesOpen: boolean
  setPropertiesOpen: Dispatch<SetStateAction<boolean>>
  notesAdded: boolean
  addNotes: () => void
  refresh: () => void
  generation: number
}
export function useConversation18Controller(
  fixture: Conversation18Fixture,
  scenario: Conversation18Scenario,
  active: boolean,
): Conversation18Controller {
  const base = useThreadController(fixture.source, scenario, active)
  const panel = useResourcePanel({
    initialOpen: false,
    initialWidth: 780,
    minWidth: 580,
    maxWidth: 1050,
  })
  const [filterText, setFilterText] = useState("")
  const [sort, setSort] = useState<InventorySort>(null)
  const [selectedRecords, setSelectedRecords] = useState<string[]>([])
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([])
  const [widths, setWidths] = useState<Record<string, number>>({
    name: 220,
    surfaces: 180,
    changed: 140,
    confidence: 160,
    source: 300,
    notes: 260,
  })
  const [propertiesOpen, setPropertiesOpen] = useState(false)
  const [notesAdded, setNotesAdded] = useState(false)
  const [generation, setGeneration] = useState(0)
  const rows = fixture.rows
    .filter((row) =>
      (row.name.en + row.name["zh-CN"] + row.surfaces)
        .toLowerCase()
        .includes(filterText.toLowerCase()),
    )
    .map((row) =>
      generation
        ? {
            ...row,
            changed: {
              "zh-CN": "刚刚刷新 · 固定版本 " + generation,
              en: "Refreshed now · fixture revision " + generation,
            },
          }
        : row,
    )
    .sort((a, b) => {
      if (!sort) return 0
      const column = sort.columnId
      const left =
        column === "name"
          ? base.copy(a.name)
          : column === "changed"
            ? base.copy(a.changed)
            : column === "notes"
              ? base.copy(a.notes)
              : a[column as "confidence" | "surfaces" | "source"]
      const right =
        column === "name"
          ? base.copy(b.name)
          : column === "changed"
            ? base.copy(b.changed)
            : column === "notes"
              ? base.copy(b.notes)
              : b[column as "confidence" | "surfaces" | "source"]
      return left.localeCompare(right) * (sort.direction === "asc" ? 1 : -1)
    })
  return {
    ...base,
    ...panel,
    rows,
    filterText,
    setFilterText,
    sort,
    setSort,
    selectedRecords,
    setSelectedRecords,
    hiddenColumns,
    setHiddenColumns,
    widths,
    setColumnWidth: (id, value) =>
      setWidths((previous) => ({ ...previous, [id]: value })),
    propertiesOpen,
    setPropertiesOpen,
    notesAdded,
    addNotes: () => {
      setNotesAdded(true)
      setHiddenColumns((previous) => previous.filter((id) => id !== "notes"))
    },
    refresh: () => setGeneration((previous) => previous + 1),
    generation,
  }
}
