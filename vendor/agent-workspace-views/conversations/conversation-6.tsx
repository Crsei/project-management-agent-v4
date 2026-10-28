"use client"
import {
  Terminal,
  Dot,
  CornerDownRight,
  ChevronRight,
  ChevronsRight,
} from "lucide-react"
import { CodePreview, FileViewer, DiffViewer, Tree } from "./resources"
import { Button, Tabs, TabsList, TabsTrigger, TabsContent } from "./ui"
import { ThreadMessage, ThreadPanel, ThreadView } from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation6Controller } from "./conversation-6-controller"
import styles from "./conversation-5-8.module.css"
export function Conversation6View({
  controller,
  host,
}: {
  controller: Conversation6Controller
  host: ComposerHost
}) {
  const { label } = controller
  const content = (
    <Tabs
      value={controller.view}
      onValueChange={(value) => controller.setView(String(value))}
    >
      <TabsList>
        <TabsTrigger value="terminal">{label("终端", "Terminal")}</TabsTrigger>
        <TabsTrigger value="files">{label("文件", "Files")} · 4</TabsTrigger>
      </TabsList>
      <TabsContent value="terminal" forceMount>
        <div className={styles.terminal}>
          <div className={styles.toolbar}>
            <strong className={styles.speaker}>
              <Terminal aria-hidden="true" /> Claude Code
            </strong>
            <span>
              {controller.status === "completed" ? "ready" : controller.status}
            </span>
            <Button variant="outline" onClick={controller.replay}>
              {label("重播本地记录", "Replay local transcript")}
            </Button>
            {controller.status === "running" && (
              <Button onClick={controller.advance}>
                {label("推进下一段", "Advance next segment")}
              </Button>
            )}
          </div>
          <h3>Claude Code</h3>
          <p>Repository session · high effort</p>
          <p>~/Developer/shadcn-analytics</p>
          <p className={styles.prompt}>
            <ChevronRight aria-hidden="true" />{" "}
            {label(
              "继续收入概览；带我审阅四个文件，尤其 chart 和 metric card。",
              "Continue the revenue overview. Walk me through the four files, especially the chart and metric card.",
            )}
          </p>
          <p>
            {label(
              "我会读取 dashboard、chart、metric card 与 formatter 的既有变更。",
              "I’ll trace the dashboard, chart, metric card and formatter from the existing changes.",
            )}
          </p>
          {controller.status === "failed" && (
            <p role="alert">
              {label(
                "固定记录读取失败；文件与草稿已保留。点击重播恢复演示。",
                "Fixture record read failed. Files and drafts are preserved; replay to recover the demo.",
              )}
            </p>
          )}
          {controller.transcript.map((record) => (
            <details key={record.id} open={record.id === "diff-stat"}>
              <summary>
                <Dot aria-hidden="true" /> {record.command}
                <br />
                <CornerDownRight aria-hidden="true" /> {record.summary} ·{" "}
                {label("展开输出", "expand output")}
              </summary>
              <CodePreview
                identity={`conversation-6-${record.id}`}
                revision="reference-v2"
                code={record.output}
                language="text"
                ariaLabel={record.command}
              />
            </details>
          ))}
          <p>
            {label(
              "四文件审阅记录就绪。formatter 是独立 helper；dashboard 的当前金额仍是固定字符串。",
              "Four-file review record ready. The formatter is a helper; current dashboard amounts remain literal strings.",
            )}
          </p>
          <p>
            <ChevronRight aria-hidden="true" />
          </p>
          <p>
            <ChevronsRight aria-hidden="true" />{" "}
            {label(
              "accept edits on · 仅展示",
              "accept edits on · display only",
            )}
          </p>
          <p className={styles.meta}>
            {label(
              "脚本化本地记录 · 无模型、Shell、PTY 或权限连接",
              "Scripted local record · no model, Shell, PTY or permission connection",
            )}
          </p>
        </div>
      </TabsContent>
      <TabsContent value="files" forceMount>
        <div className={styles.repository}>
          <aside className={styles.fileTree}>
            <p className={styles.meta}>main · shadcn-analytics</p>
            <Tree
              label={label("工作区文件", "Workspace files")}
              nodes={controller.files.map((file) => ({
                id: file.fileId,
                label: file.path,
              }))}
              selectedId={controller.fileId}
              onSelect={(node) => controller.setFileId(node.id)}
            />
          </aside>
          <div className={styles.editor}>
            <div className={styles.toolbar}>
              <Button
                variant="outline"
                aria-pressed={controller.fileView === "code"}
                onClick={() => controller.setFileView("code")}
              >
                Code
              </Button>
              <Button
                variant="outline"
                aria-pressed={controller.fileView === "changes"}
                onClick={() => controller.setFileView("changes")}
              >
                Changes
              </Button>
            </div>
            {controller.fileView === "code" ? (
              <FileViewer file={controller.file} revision="reference-v2" />
            ) : (
              <DiffViewer file={controller.file} mode="split" />
            )}
          </div>
        </div>
      </TabsContent>
    </Tabs>
  )
  return (
    <ThreadView
      page="conversation-6"
      controller={controller}
      host={host}
      showSessionNavigation={false}
      layout="workbench"
      resource={{
        title: label("终端与文件", "Terminal and files"),
        content,
        controller,
        header: (
          <span>shadcn-analytics · {label("本地演示", "Local demo")}</span>
        ),
      }}
      beforeInput={
        <p className={styles.meta}>
          main · 4 files changed · Repo context · Claude Code
        </p>
      }
      renderMessage={(message) => (
        <ThreadMessage
          message={message}
          controller={controller}
          author={message.role === "assistant" ? "Claude Code" : undefined}
          agentRole={
            message.role === "assistant" ? "Code agent · Local demo" : undefined
          }
        >
          {message.id === "conversation-6-answer" && (
            <>
              <ThreadPanel
                title={label(
                  "已编辑 4 个文件 · 固定快照",
                  "Edited 4 files · fixed snapshot",
                )}
              >
                <p>Revenue overview · +61 −6</p>
                <div className={styles.fileSummary}>
                  {controller.files.map((file) => (
                    <Button
                      key={file.fileId}
                      variant="ghost"
                      onClick={() => {
                        controller.setFileId(file.fileId)
                        controller.setView("files")
                        controller.setPanelOpen(true)
                      }}
                    >
                      {file.path}
                      <span>{file.kind === "added" ? "A" : "M"}</span>
                    </Button>
                  ))}
                </div>
              </ThreadPanel>
              <div className={styles.toolbar}>
                <Button
                  variant="outline"
                  onClick={() => {
                    controller.setFileId("chart")
                    controller.setView("files")
                    controller.setPanelOpen(true)
                  }}
                >
                  {label("审阅图表", "Review the chart")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    controller.updateDraft({
                      text: label(
                        "解释仓库布局",
                        "Explain the repository layout",
                      ),
                    })
                  }
                >
                  {label("解释仓库布局", "Explain repo layout")}
                </Button>
              </div>
            </>
          )}
        </ThreadMessage>
      )}
    />
  )
}
