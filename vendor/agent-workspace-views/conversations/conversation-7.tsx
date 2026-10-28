"use client"
import { useEffect, useRef } from "react"
import {
  Monitor,
  Tablet,
  Smartphone,
  Maximize2,
  Minimize2,
  RotateCw,
} from "lucide-react"
import {
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui"
import { Tree, FileViewer } from "./resources"
import { ThreadActivity, ThreadMessage, ThreadView } from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation7Controller } from "./conversation-7-controller"
import styles from "./conversation-5-8.module.css"
function MaximizedStaticPreview({
  html,
  onEscape,
}: {
  html: string
  onEscape: () => void
}) {
  const preview = useRef<HTMLIFrameElement | null>(null)
  useEffect(() => {
    const frame = preview.current
    if (!frame) return
    let previewDocument: Document | null = null
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      onEscape()
    }
    // Child-document keyboard events do not reach Radix in the parent document.
    const listen = () => {
      previewDocument?.removeEventListener("keydown", onKeyDown)
      previewDocument = frame.contentDocument
      previewDocument?.addEventListener("keydown", onKeyDown)
    }
    frame.addEventListener("load", listen)
    listen()
    return () => {
      frame.removeEventListener("load", listen)
      previewDocument?.removeEventListener("keydown", onKeyDown)
    }
  }, [html, onEscape])
  return (
    <iframe
      ref={preview}
      title="Mainline maximized safe static preview"
      sandbox="allow-same-origin"
      srcDoc={html}
    />
  )
}
export function Conversation7View({
  controller,
  host,
}: {
  controller: Conversation7Controller
  host: ComposerHost
}) {
  const { label } = controller
  const maximizeFocus = useRef<HTMLButtonElement | null>(null)
  const maximizedTitle = useRef<HTMLHeadingElement | null>(null)
  const content = (
    <Tabs
      value={controller.view}
      onValueChange={(value) => controller.setView(String(value))}
    >
      <TabsList>
        <TabsTrigger value="preview">{label("预览", "Preview")}</TabsTrigger>
        <TabsTrigger value="code">Code</TabsTrigger>
      </TabsList>
      <TabsContent value="preview" forceMount>
        <div className={styles.toolbar}>
          <span className={styles.meta}>
            mainline-marketing · / · v{controller.revision}
          </span>
          <Button
            size="icon"
            variant="ghost"
            aria-label={label("刷新预览", "Refresh preview")}
            onClick={controller.reload}
          >
            <RotateCw />
          </Button>
          {[
            { id: "desktop", Icon: Monitor },
            { id: "tablet", Icon: Tablet },
            { id: "phone", Icon: Smartphone },
          ].map(({ id, Icon }) => (
            <Button
              key={id}
              size="icon"
              variant="ghost"
              aria-label={id}
              aria-pressed={controller.viewport === id}
              onClick={() => controller.setViewport(id)}
            >
              <Icon />
            </Button>
          ))}
          <Button
            size="icon"
            variant="ghost"
            aria-label={label("最大化预览", "Maximize preview")}
            aria-pressed={controller.maximized}
            onClick={(event) => {
              maximizeFocus.current = event.currentTarget
              controller.toggleMaximized()
            }}
          >
            {controller.maximized ? <Minimize2 /> : <Maximize2 />}
          </Button>
        </div>
        {controller.previewError ? (
          <div role="alert" className={styles.notice}>
            {label(
              "固定预览加载失败；会话与草稿已保留。",
              "Fixed preview failed; conversation and draft are preserved.",
            )}
            <Button variant="outline" onClick={controller.reload}>
              {label("重试预览", "Retry preview")}
            </Button>
          </div>
        ) : (
          <div className={styles.preview} data-viewport={controller.viewport}>
            <iframe
              key={controller.revision}
              title="Mainline landing page · safe static preview"
              sandbox="allow-same-origin"
              srcDoc={controller.html}
            />
          </div>
        )}
        <p className={styles.meta}>
          {label(
            "固定静态 HTML · script-src none · 不执行生成 JSX；导航锚点与 FAQ 可交互",
            "Fixed static HTML · script-src none · no generated JSX execution; working anchors and FAQ",
          )}
        </p>
      </TabsContent>
      <TabsContent value="code" forceMount>
        <div className={styles.repository}>
          <aside className={styles.fileTree}>
            <p className={styles.meta}>mainline-marketing · main</p>
            <Tree
              label={label("营销页面仓库", "Marketing repository")}
              nodes={[
                {
                  id: "src",
                  label: "src",
                  children: [
                    {
                      id: "app",
                      label: "app",
                      children: [{ id: "page", label: "page.tsx" }],
                    },
                    {
                      id: "marketing",
                      label: "components/marketing",
                      children: [
                        { id: "hero", label: "hero.tsx" },
                        { id: "features", label: "features.tsx" },
                      ],
                    },
                  ],
                },
              ]}
              defaultExpandedIds={["src", "app", "marketing"]}
              selectedId={controller.fileId}
              onSelect={(node) => {
                if (controller.files.some((file) => file.fileId === node.id))
                  controller.setFileId(node.id)
              }}
            />
          </aside>
          <div className={styles.editor}>
            <FileViewer file={controller.file} revision="reference-v2" />
            <p className={styles.meta}>
              {label(
                "只读参考 JSX 快照；预览来自固定 HTML，不编译此代码",
                "Read-only reference JSX snapshot; the preview uses fixed HTML and does not compile this source",
              )}
            </p>
          </div>
        </div>
      </TabsContent>
    </Tabs>
  )
  return (
    <>
      <ThreadView
        page="conversation-7"
        controller={controller}
        host={host}
        showSessionNavigation={false}
        layout="workbench"
        resource={{
          title: "Mainline landing page",
          content,
          controller,
          header: (
            <span>
              Mainline landing page ·{" "}
              {label("就绪 · 本地演示", "Ready · Local demo")}
            </span>
          ),
        }}
        beforeInput={
          <p className={styles.meta}>
            Workspace · mainline-marketing ·{" "}
            {label("安全静态预览", "Safe static preview")}
          </p>
        }
        renderMessage={(message) => (
          <ThreadMessage
            message={message}
            controller={controller}
            author={
              message.role === "assistant" ? "Shadcnblocks AI" : undefined
            }
            agentRole={
              message.role === "assistant"
                ? "Code agent · Local demo"
                : undefined
            }
            activity={
              message.id === "conversation-7-answer" ? (
                <ThreadActivity
                  title={label("读取项目文件", "Read project files")}
                >
                  {controller.files.map((file, i) => (
                    <Button
                      key={file.fileId}
                      variant="ghost"
                      onClick={() => {
                        controller.setFileId(file.fileId)
                        controller.setView("code")
                        controller.setPanelOpen(true)
                      }}
                    >
                      {
                        [
                          label(
                            "组合完整 landing page",
                            "Composed complete landing page",
                          ),
                          label("适配 Mainline hero", "Adapted Mainline hero"),
                          label("响应式功能网格", "Responsive feature grid"),
                        ][i]
                      }{" "}
                      · {file.path}
                    </Button>
                  ))}
                </ThreadActivity>
              ) : undefined
            }
          >
            {message.id === "c7-ready" && (
              <div className={styles.toolbar}>
                <Button
                  variant="outline"
                  onClick={() => {
                    controller.setView("preview")
                    controller.setPanelOpen(true)
                  }}
                >
                  {label("打开预览", "Open preview")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    controller.setView("code")
                    controller.setPanelOpen(true)
                  }}
                >
                  {label("查看代码", "View code")}
                </Button>
              </div>
            )}
          </ThreadMessage>
        )}
      />
      <Dialog
        open={controller.maximized && controller.active}
        onOpenChange={(open) => {
          if (!open) controller.toggleMaximized()
        }}
      >
        <DialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            maximizedTitle.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            maximizeFocus.current?.focus()
          }}
          className={styles.maximizedDialog}
          style={{
            maxWidth: "calc(100vw - 32px)",
            width: "calc(100vw - 32px)",
            height: "calc(100dvh - 32px)",
          }}
        >
          <DialogTitle ref={maximizedTitle} tabIndex={-1}>
            Mainline landing page ·{" "}
            {label("最大化静态预览", "Maximized static preview")}
          </DialogTitle>
          <DialogDescription>
            {label(
              "固定本地 HTML，禁用脚本，不连接外部网站。",
              "Fixed local HTML with scripts disabled; no external website connection.",
            )}
          </DialogDescription>
          <div className={styles.preview} data-viewport={controller.viewport}>
            <MaximizedStaticPreview
              html={controller.html}
              onEscape={controller.toggleMaximized}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
