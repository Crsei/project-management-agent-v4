"use client"
import { useRef, useState, type RefObject } from "react"
import { Copy, Download } from "lucide-react"
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "./ui"
import { Markdown } from "./markdown"
import { ReadOnlyEditor } from "./resources"
import type { LocalArtifact } from "./artifact-model"
import type { ThreadController } from "./shared"

export interface ArtifactPreviewState {
  artifacts: readonly LocalArtifact[]
  artifact: LocalArtifact | undefined
  setArtifactId: (id: string | null) => void
  finalFocus: RefObject<HTMLElement | null>
  openArtifact: (id: string) => void
}
export function useArtifactPreview(
  artifacts: readonly LocalArtifact[],
): ArtifactPreviewState {
  const [artifactId, setArtifactId] = useState<string | null>(null)
  const finalFocus = useRef<HTMLElement | null>(null)
  return {
    artifacts,
    artifact: artifacts.find((item) => item.id === artifactId),
    setArtifactId,
    finalFocus,
    openArtifact: (id) => {
      finalFocus.current = document.activeElement as HTMLElement
      setArtifactId(id)
    },
  }
}
export function LocalArtifactPreview({
  controller,
  messageId,
}: {
  controller: ThreadController & ArtifactPreviewState
  messageId: string
}) {
  const { artifact, copy, label } = controller
  const [copyReceipt, setCopyReceipt] = useState<{
    artifactId: string
    state: "copied" | "error"
  } | null>(null)
  const copyState =
    copyReceipt && copyReceipt.artifactId === artifact?.id
      ? copyReceipt.state
      : "idle"
  return (
    <Dialog
      open={Boolean(artifact) && controller.active}
      onOpenChange={(open) => {
        if (!open) controller.setArtifactId(null)
      }}
    >
      <DialogContent
        className="sm:max-w-4xl"
        onCloseAutoFocus={(event) => {
          if (controller.active && controller.finalFocus.current?.isConnected) {
            event.preventDefault()
            controller.finalFocus.current.focus({ preventScroll: true })
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {artifact
              ? copy(artifact.title)
              : label("本地产物", "Local artifact")}
          </DialogTitle>
          <DialogDescription>
            {artifact?.name} ·{" "}
            {label(
              "本地固定产物，不会写入外部服务",
              "Fixed local artifact; no external service writes",
            )}
          </DialogDescription>
        </DialogHeader>
        {artifact && (
          <div data-artifact-source-message={messageId}>
            {!artifact.available ? (
              <p role="alert">
                {label(
                  "产物内容不可用；会话和草稿保留。",
                  "Artifact content is unavailable; conversation and draft are preserved.",
                )}
              </p>
            ) : (
              <>
                <div className="mb-3 flex items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          copy(artifact.content),
                        )
                        setCopyReceipt({
                          artifactId: artifact.id,
                          state: "copied",
                        })
                      } catch {
                        setCopyReceipt({
                          artifactId: artifact.id,
                          state: "error",
                        })
                      }
                    }}
                  >
                    <Copy />
                    {label("复制内容", "Copy content")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      const url = URL.createObjectURL(
                        new Blob([copy(artifact.content)], {
                          type: "text/plain;charset=utf-8",
                        }),
                      )
                      const anchor = document.createElement("a")
                      anchor.href = url
                      anchor.download = artifact.name
                      anchor.click()
                      setTimeout(() => URL.revokeObjectURL(url), 1000)
                    }}
                  >
                    <Download />
                    {label("下载本地文件", "Download local file")}
                  </Button>
                  {copyState !== "idle" && (
                    <span role={copyState === "error" ? "alert" : "status"}>
                      {copyState === "copied"
                        ? label("已复制", "Copied")
                        : label(
                            "复制失败，请手动选择文本。",
                            "Copy failed; select the text manually.",
                          )}
                    </span>
                  )}
                </div>
                <Tabs defaultValue="preview">
                  <TabsList>
                    <TabsTrigger value="preview">
                      {label("预览", "Preview")}
                    </TabsTrigger>
                    <TabsTrigger value="source">
                      {label("源码", "Source")}
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent
                    value="preview"
                    forceMount
                    className="max-h-[55vh] overflow-y-auto p-4"
                  >
                    <Markdown
                      content={copy(artifact.content)}
                      locale={controller.locale}
                    />
                  </TabsContent>
                  <TabsContent value="source" forceMount>
                    <ReadOnlyEditor
                      identity={`${controller.projectId}/${controller.selectedId}/${artifact.id}`}
                      revision="local-v1"
                      code={copy(artifact.content)}
                      path={artifact.name}
                      language="markdown"
                      maxHeight="55vh"
                    />
                  </TabsContent>
                </Tabs>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
