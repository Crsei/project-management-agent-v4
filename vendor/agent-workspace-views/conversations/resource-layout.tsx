"use client"
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react"
import { X } from "lucide-react"
import {
  Button,
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
  type PanelImperativeHandle,
} from "./ui"
import type { ThreadController } from "./shared"

export interface ResourcePanelOptions {
  initialOpen?: boolean
  initialWidth?: number
  minWidth?: number
  maxWidth?: number
}
export interface ResourcePanelController {
  panelOpen: boolean
  setPanelOpen: Dispatch<SetStateAction<boolean>>
  panelWidth: number
  setPanelWidth: Dispatch<SetStateAction<number>>
  bounds: { min: number; max: number }
}
export function useResourcePanel({
  initialOpen = true,
  initialWidth = 320,
  minWidth = 280,
  maxWidth = 360,
}: ResourcePanelOptions = {}): ResourcePanelController {
  const [panelOpen, setPanelOpen] = useState(initialOpen)
  const [panelWidth, setPanelWidth] = useState(() =>
    Math.min(maxWidth, Math.max(minWidth, initialWidth)),
  )
  const bounds = useMemo(
    () => ({ min: minWidth, max: maxWidth }),
    [minWidth, maxWidth],
  )
  return { panelOpen, setPanelOpen, panelWidth, setPanelWidth, bounds }
}
export function ThreadResourceLayout({
  canvas,
  children,
  title,
  controller,
  header,
  side = "right",
}: {
  canvas: ReactNode
  children: ReactNode
  title: string
  controller: ThreadController & ResourcePanelController
  header?: ReactNode
  side?: "left" | "right"
}) {
  const id = useId()
  const resourcePanel = useRef<PanelImperativeHandle | null>(null)
  useEffect(() => {
    if (controller.panelOpen) resourcePanel.current?.expand()
    else resourcePanel.current?.collapse()
  }, [controller.panelOpen, controller.active])
  const panel = (
    <ResizablePanel
      id={`${id}-resource`}
      panelRef={resourcePanel}
      defaultSize={controller.panelWidth}
      minSize={controller.bounds.min}
      maxSize={controller.bounds.max}
      collapsible
      collapsedSize={0}
      onResize={(size) => {
        if (!controller.panelOpen && size.inPixels > 0) {
          resourcePanel.current?.collapse()
          return
        }
        if (size.inPixels > 0 && controller.panelOpen)
          controller.setPanelWidth((previous) =>
            Math.abs(previous - size.inPixels) > 0.5 ? size.inPixels : previous,
          )
      }}
    >
      <section
        id={id}
        hidden={!controller.panelOpen}
        style={{ display: controller.panelOpen ? undefined : "none" }}
        aria-label={title}
        className="flex h-full min-h-0 flex-col bg-background"
        data-thread-resource-panel
      >
        <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-3">
          {header ?? (
            <h2 className="truncate text-sm font-medium" title={title}>
              {title}
            </h2>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={controller.label(
              "关闭资源面板",
              "Close resource panel",
            )}
            onClick={() => {
              controller.setPanelOpen(false)
              controller.focusComposer()
            }}
          >
            <X aria-hidden="true" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden p-3">{children}</div>
      </section>
    </ResizablePanel>
  )
  const separator = (
    <ResizableHandle
      hidden={!controller.panelOpen}
      style={{ display: controller.panelOpen ? undefined : "none" }}
      aria-label={controller.label("调整资源面板宽度", "Resize resource panel")}
      aria-controls={id}
    />
  )
  const thread = (
    <ResizablePanel id={`${id}-thread`} minSize={180}>
      <div className="flex h-full min-h-0 min-w-0 flex-col">{canvas}</div>
    </ResizablePanel>
  )
  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="h-full min-h-0 min-w-0 flex-1"
      data-thread-resource-layout
      data-resource-side={side}
    >
      {side === "left" ? (
        <>
          {panel}
          {separator}
          {thread}
        </>
      ) : (
        <>
          {thread}
          {separator}
          {panel}
        </>
      )}
    </ResizablePanelGroup>
  )
}
