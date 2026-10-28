"use client"
import { Tree, FileViewer, DiffViewer, ChangeReviewPanel } from "./resources"
import { Button, Tabs, TabsList, TabsTrigger, TabsContent } from "./ui"
import type { ComposerHost } from "../composer-workspace-view"
import {
  ThreadActivity,
  ThreadMessage,
  ThreadPanel,
  ThreadView,
} from "./shared"
import type { Conversation5Controller } from "./conversation-5-controller"
import styles from "./conversation-5-8.module.css"
export function Conversation5View({
  controller,
  host,
}: {
  controller: Conversation5Controller
  host: ComposerHost
}) {
  const { label } = controller
  const content = (
    <div className={styles.repository}>
      <aside className={styles.fileTree}>
        <p className={styles.meta}>main · shadcn-analytics</p>
        <Tree
          label={label("仓库文件", "Repository files")}
          nodes={[
            {
              id: "src",
              label: "src",
              children: [
                {
                  id: "app",
                  label: "app",
                  children: [
                    {
                      id: "dashboard",
                      label: "dashboard",
                      children: [{ id: "page", label: "page.tsx" }],
                    },
                  ],
                },
                {
                  id: "components",
                  label: "components",
                  children: [
                    {
                      id: "dashboard-components",
                      label: "dashboard",
                      children: [
                        { id: "chart", label: "revenue-chart.tsx" },
                        { id: "metric", label: "metric-card.tsx" },
                      ],
                    },
                  ],
                },
                {
                  id: "lib",
                  label: "lib",
                  children: [{ id: "format", label: "format-currency.ts" }],
                },
              ],
            },
          ]}
          selectedId={controller.fileId}
          onSelect={(node) => {
            if (
              controller.changes.files.some((file) => file.fileId === node.id)
            )
              controller.setFileId(node.id)
          }}
          defaultExpandedIds={[
            "src",
            "app",
            "dashboard",
            "components",
            "dashboard-components",
            "lib",
          ]}
        />
        <p className={styles.meta}>
          {label("4 个文件 · +61 −6", "4 files · +61 −6")}
        </p>
      </aside>
      <div className={styles.editor}>
        <Tabs
          value={controller.view}
          onValueChange={(value) => controller.setView(String(value))}
        >
          <TabsList>
            <TabsTrigger value="code">{label("代码", "Code")}</TabsTrigger>
            <TabsTrigger value="changes">
              {label("变更", "Changes")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="code" forceMount>
            <FileViewer
              file={controller.file}
              revision={controller.changes.revision}
            />
          </TabsContent>
          <TabsContent value="changes" forceMount>
            <p className={styles.meta}>
              {controller.file.path} ·{" "}
              {label("固定并排变更", "Fixed split diff")}
            </p>
            <DiffViewer
              file={controller.file}
              mode="split"
              revision={controller.changes.revision}
            />
            <Button variant="outline" onClick={controller.openReview}>
              {label("审阅 4 个变更文件", "Review 4 changed files")}
            </Button>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
  return (
    <ThreadView
      page="conversation-5"
      controller={controller}
      host={host}
      showSessionNavigation={false}
      layout="workbench"
      resource={{
        title: label("代码与仓库", "Code and repository"),
        content,
        controller,
        header: (
          <span>
            main · shadcn-analytics · {label("本地演示", "Local demo")}
          </span>
        ),
      }}
      beforeInput={
        <p className={styles.meta}>
          Codebase · shadcn-analytics · main ·{" "}
          {label("固定源码，不写入 Git", "Fixed source; no Git writes")}
        </p>
      }
      mainView={{
        open: controller.reviewOpen,
        content: (
          <section>
            <Button variant="outline" onClick={controller.closeReview}>
              {label("返回对话", "Return to conversation")}
            </Button>
            <ChangeReviewPanel
              scopeId="conversation-5"
              changes={controller.changes}
              selectedFileId={controller.fileId}
              onSelectFile={controller.setFileId}
              comments={controller.comments}
              onCommentsChange={controller.setComments}
            />
          </section>
        ),
      }}
      renderMessage={(message) => (
        <ThreadMessage
          message={message}
          controller={controller}
          author={message.role === "assistant" ? "Shadcnblocks AI" : undefined}
          agentRole={
            message.role === "assistant" ? "Code agent · Local demo" : undefined
          }
          activity={
            message.id === "conversation-5-answer" ? (
              <ThreadActivity
                title={label(
                  "已探索仓库 · 实现计划就绪",
                  "Explored repository · implementation plan ready",
                )}
              >
                <div>src/app/dashboard/page.tsx</div>
                <div>src/components/ui/chart.tsx</div>
                <div>metric-card.tsx · format-currency.ts</div>
              </ThreadActivity>
            ) : undefined
          }
        >
          {message.id === "c5-implemented" && (
            <ThreadPanel
              title={label(
                "4 个文件已变更 · 固定快照",
                "4 changed files · fixed snapshot",
              )}
            >
              <div className={styles.fileSummary}>
                {controller.changes.files.map((file, i) => (
                  <Button
                    key={file.fileId}
                    variant="ghost"
                    onClick={() => {
                      controller.setFileId(file.fileId)
                      controller.setView("changes")
                      controller.setPanelOpen(true)
                    }}
                  >
                    {file.path.split("/").pop()}{" "}
                    <span>{["+12 −2", "+34 −1", "+8 −3", "+7"][i]}</span>
                  </Button>
                ))}
              </div>
              <Button variant="outline" onClick={controller.openReview}>
                {label("审阅变更", "Review changes")} · +61 −6
              </Button>
            </ThreadPanel>
          )}
          {message.id === "c5-retained" && (
            <div className={styles.toolbar}>
              <Button
                variant="outline"
                onClick={() => {
                  controller.setView("code")
                  controller.setPanelOpen(true)
                }}
              >
                {label("打开源码", "Open source")}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  controller.setView("changes")
                  controller.setPanelOpen(true)
                }}
              >
                {label("打开变更", "Open changes")}
              </Button>
            </div>
          )}
        </ThreadMessage>
      )}
    />
  )
}
