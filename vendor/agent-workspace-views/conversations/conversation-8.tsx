"use client"
import { useCallback, useRef } from "react"
import { Button, Input, Tabs, TabsList, TabsTrigger, TabsContent } from "./ui"
import { LocalArtifactPreview } from "./artifacts"
import {
  ThreadActivity,
  ThreadMessage,
  ThreadPanel,
  ThreadView,
} from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation8Controller } from "./conversation-8-controller"
import styles from "./conversation-5-8.module.css"
export function Conversation8View({
  controller,
  host,
}: {
  controller: Conversation8Controller
  host: ComposerHost
}) {
  const { label, copy, video: videoRef, setDuration } = controller
  const bindVideo = useCallback(
    (element: HTMLVideoElement | null) => {
      videoRef.current = element
      if (element && Number.isFinite(element.duration))
        setDuration(element.duration)
    },
    [videoRef, setDuration],
  )
  const sourceInput = useRef<HTMLInputElement>(null)
  const current = [...controller.cues]
    .reverse()
    .find((cue) => cue.start <= controller.time)?.id
  const visibleCues = controller.cues.filter((cue) =>
    `${cue.speaker} ${copy(cue.text)}`
      .toLowerCase()
      .includes(controller.transcriptQuery.toLowerCase()),
  )
  const navigation = (
    <nav
      className={styles.productionNav}
      aria-label={label("内容生产导航", "Content production navigation")}
    >
      <h2>{label("内容工作室", "Content studio")}</h2>
      {[
        { id: "overview", zh: "概览", en: "Overview" },
        { id: "sources", zh: "来源库", en: "Source library" },
        { id: "pipeline", zh: "内容流水线", en: "Content pipeline" },
      ].map((item) => (
        <Button
          key={item.id}
          variant="ghost"
          aria-pressed={controller.section === item.id}
          onClick={() => controller.setSection(item.id)}
        >
          {label(item.zh, item.en)}
        </Button>
      ))}
      <h3>{label("制作", "Production")}</h3>
      {[
        { id: "recording", zh: "录制", en: "Recordings" },
        { id: "drafts", zh: "草稿", en: "Drafts" },
        { id: "speakers", zh: "说话人", en: "Speakers" },
      ].map((item) => (
        <Button
          key={item.id}
          variant="ghost"
          aria-pressed={controller.section === item.id}
          onClick={() => controller.setSection(item.id)}
        >
          {label(item.zh, item.en)}
        </Button>
      ))}
      <h3>{label("录制项目", "Recording projects")}</h3>
      <Button
        variant="ghost"
        onClick={() => controller.setSection("recording")}
      >
        {label("创意工作未来", "Future of creative work")}
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          controller.setSection("overview")
          controller.updateDraft({
            text: label(
              "为 Design systems roundtable 创建本地内容计划",
              "Create a local content plan for the Design systems roundtable",
            ),
          })
        }}
      >
        Design systems roundtable
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          controller.setSection("overview")
          controller.updateDraft({
            text: label(
              "为 Founder interview series 创建本地内容计划",
              "Create a local content plan for the Founder interview series",
            ),
          })
        }}
      >
        Founder interview series
      </Button>
    </nav>
  )
  const content = (
    <div>
      <p className={styles.meta}>
        {label(
          "38 分钟 · 4 位合成角色 · 5 份本地来源",
          "38 minutes · 4 synthetic roles · 5 local sources",
        )}
      </p>
      <video
        ref={bindVideo}
        className={styles.video}
        controls
        preload="metadata"
        src="/fixtures/conversation-8/creative-work-roundtable.mp4"
        onLoadedMetadata={(event) =>
          controller.setDuration(event.currentTarget.duration)
        }
        onTimeUpdate={(event) =>
          controller.setTime(event.currentTarget.currentTime)
        }
        onError={() => controller.setMediaError(true)}
        aria-label={label(
          "创意工作未来 · 合成视频",
          "Future of creative work · synthetic video",
        )}
      />
      {controller.mediaError && (
        <div role="alert" className={styles.notice}>
          {label(
            "视频示例读取失败；草稿与转录保留。",
            "Video fixture failed; draft and transcript are preserved.",
          )}
          <Button variant="outline" onClick={controller.retryMedia}>
            {label("重试媒体", "Retry media")}
          </Button>
        </div>
      )}
      <p className={styles.meta} role="status">
        {Math.floor(controller.time / 60)
          .toString()
          .padStart(2, "0")}
        :
        {Math.floor(controller.time % 60)
          .toString()
          .padStart(2, "0")}{" "}
        /{" "}
        {controller.duration
          ? "38:12"
          : label("等待媒体元数据", "Waiting for metadata")}{" "}
        ·{" "}
        {label(
          "本地合成文字视频，不是真实录制",
          "Local synthetic text-video, not a real recording",
        )}
      </p>
      <Tabs
        value={controller.tab}
        onValueChange={(value) => controller.setTab(String(value))}
      >
        <TabsList>
          <TabsTrigger value="transcript">
            {label("转录", "Transcript")}
          </TabsTrigger>
          <TabsTrigger value="clips">{label("片段", "Clips")}</TabsTrigger>
        </TabsList>
        <TabsContent value="transcript" forceMount>
          <Input
            type="search"
            value={controller.transcriptQuery}
            onChange={(event) =>
              controller.setTranscriptQuery(event.target.value)
            }
            aria-label={label(
              "搜索转录或说话人",
              "Search transcript or speaker",
            )}
            placeholder={label("搜索转录…", "Search transcript…")}
          />
          {visibleCues.length === 0 && (
            <p role="status">
              {label("没有匹配的转录。", "No transcript matches.")}
            </p>
          )}
          {visibleCues.map((cue) => (
            <article
              key={cue.id}
              className={styles.cue}
              data-current={current === cue.id}
            >
              <Button
                variant="ghost"
                onClick={() => controller.seek(cue.start)}
                disabled={!controller.duration || controller.mediaError}
              >
                <span className={styles.speaker}>
                  <span className={styles.avatar}>
                    {cue.speaker
                      .split(" ")
                      .map((name) => name[0])
                      .join("")}
                  </span>
                  {cue.speaker}
                </span>
                <span>
                  {Math.floor(cue.start / 60)
                    .toString()
                    .padStart(2, "0")}
                  :{(cue.start % 60).toString().padStart(2, "0")}
                </span>
              </Button>
              <p>{copy(cue.text)}</p>
              <span className={styles.meta}>
                {label("引用", "References")}{" "}
                {cue.references.map((reference) => `[${reference}]`).join(" ")}
              </span>
            </article>
          ))}
        </TabsContent>
        <TabsContent value="clips">
          {controller.cues.map((cue) => (
            <ThreadPanel key={cue.id} title={`${cue.speaker} · ${cue.id}`}>
              <p>{copy(cue.text)}</p>
              <Button
                variant="outline"
                onClick={() => {
                  controller.setTab("transcript")
                  controller.setTranscriptQuery("")
                  controller.seek(cue.start)
                }}
              >
                {label("定位原片段", "Locate source clip")}
              </Button>
            </ThreadPanel>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  )
  const library = (
    <div className={styles.sourceList}>
      {controller.sources.map((source) => (
        <a
          key={source.id}
          href={`/fixtures/conversation-8/editorial-research-notes.pdf#page=${source.page}`}
          target="_blank"
          rel="noreferrer"
        >
          {source.title} · {label("固定本地 PDF 页", "Fixed local PDF page")}{" "}
          {source.page}
        </a>
      ))}
      {controller.addedSources.map((source, i) => (
        <p key={`${source}-${i}`}>{source}</p>
      ))}
      <Button variant="outline" onClick={() => sourceInput.current?.click()}>
        {label("添加本地来源", "Add local source")}
      </Button>
    </div>
  )
  const businessView = (
    <section className={styles.brief}>
      <Button
        variant="outline"
        onClick={() => controller.setSection("recording")}
      >
        {label("返回录制会话", "Return to recording conversation")}
      </Button>
      <h3>
        {label("内容制作", "Content production")} · {controller.section}
      </h3>
      {controller.section === "sources" ? (
        library
      ) : controller.section === "speakers" ? (
        <div className={styles.sourceList}>
          {[...new Set(controller.cues.map((cue) => cue.speaker))].map(
            (speaker) => (
              <p key={speaker}>
                {speaker} · {label("固定合成角色", "Fixed synthetic role")}
              </p>
            ),
          )}
        </div>
      ) : controller.section === "drafts" ? (
        controller.artifacts.map((artifact) => (
          <Button
            key={artifact.id}
            variant="outline"
            onClick={() => controller.openArtifact(artifact.id)}
          >
            {copy(artifact.title)}
          </Button>
        ))
      ) : controller.section === "pipeline" ? (
        <ol className={styles.sourceList}>
          <li>{label("已关联 5 份固定来源", "5 fixed sources linked")}</li>
          <li>
            {label("已整理 12 个固定引用", "12 fixed references prepared")}
          </li>
          <li>
            {label(
              "编辑 brief 待审阅，未发布",
              "Editorial brief awaiting review, not published",
            )}
          </li>
          <li>
            <Button
              variant="outline"
              onClick={() => controller.openArtifact("brief")}
            >
              {label("审阅 brief", "Review brief")}
            </Button>
          </li>
        </ol>
      ) : (
        <div className={styles.sourceList}>
          <p>
            Future of creative work · 38:12 · 4 speakers · 5 sources · 12
            references
          </p>
          <p>
            {label(
              "2 份本地文稿 · 等待人工审阅 · 无远程发布操作",
              "2 local drafts · awaiting human review · no remote publication",
            )}
          </p>
          <Button
            variant="outline"
            onClick={() => controller.setSection("sources")}
          >
            {label("查看来源", "View sources")}
          </Button>
        </div>
      )}
    </section>
  )
  return (
    <>
      <input
        ref={sourceInput}
        type="file"
        hidden
        accept=".pdf,.txt,.md"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) controller.addSource(file)
          event.target.value = ""
        }}
      />
      <ThreadView
        page="conversation-8"
        controller={controller}
        host={host}
        showSessionNavigation
        workspaceNavigation={navigation}
        resource={{
          title: label("创意工作未来", "Future of creative work"),
          content,
          controller,
          header: (
            <span>
              {label(
                "创意工作未来 · 视频录制",
                "Future of creative work · Video recording",
              )}
            </span>
          ),
        }}
        title={{
          "zh-CN": "录制综合与转录",
          en: "Recording synthesis and transcript",
        }}
        headerActions={
          <Button
            variant="outline"
            onClick={() => controller.openArtifact("brief")}
          >
            {label("创建内容", "Create content")}
          </Button>
        }
        beforeInput={
          <p className={styles.meta}>
            {label(
              "来源 · 固定本地内容示例；不会转录、上传或发布",
              "Sources · fixed local content; no transcription, upload or publishing",
            )}
          </p>
        }
        mainView={{
          open: controller.section !== "recording",
          content: businessView,
        }}
        renderMessage={(message) => (
          <ThreadMessage
            message={message}
            controller={controller}
            author={
              message.role === "assistant" ? "Shadcnblocks AI" : undefined
            }
            agentRole={
              message.role === "assistant"
                ? "Content agent · Local demo"
                : undefined
            }
            activity={
              message.id === "conversation-8-answer" ? (
                <ThreadActivity
                  title={label(
                    "素材综合 · 固定记录",
                    "Source synthesis · fixed record",
                  )}
                >
                  <div>
                    {label(
                      "38 分钟视频转录 · 4 位角色",
                      "38-minute transcript · 4 speaker roles",
                    )}
                  </div>
                  <div>
                    {label(
                      "已审阅关联材料 · 5 份来源",
                      "Reviewed linked material · 5 sources",
                    )}
                  </div>
                  <div>
                    {label(
                      "论断与时刻对齐 · 12 个引用",
                      "Aligned claims and moments · 12 references",
                    )}
                  </div>
                </ThreadActivity>
              ) : undefined
            }
          >
            {message.id === "conversation-8-user" && (
              <div className={styles.attachments}>
                <a
                  href="/fixtures/conversation-8/creative-work-roundtable.mp4"
                  target="_blank"
                  rel="noreferrer"
                >
                  <strong>creative-work-roundtable.mp4</strong>
                  <span>38:12 · {label("合成视频", "Synthetic video")}</span>
                </a>
                <a
                  href="/fixtures/conversation-8/editorial-research-notes.pdf"
                  target="_blank"
                  rel="noreferrer"
                >
                  <strong>editorial-research-notes.pdf</strong>
                  <span>
                    12 pages ·{" "}
                    {label("本地编辑材料", "Local editorial material")}
                  </span>
                </a>
              </div>
            )}
            {message.id === "conversation-8-answer" && (
              <>
                <ThreadPanel
                  title={label(
                    "创意工作未来 — 编辑 brief",
                    "Future of creative work — editorial brief",
                  )}
                >
                  <p>
                    {label(
                      "生成文档 · 固定示例 · 3 个章节",
                      "Generated document · fixed fixture · 3 sections",
                    )}
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => controller.openArtifact("brief")}
                  >
                    {label("打开 brief", "Open brief")}
                  </Button>
                </ThreadPanel>
                <div className={styles.toolbar}>
                  <Button
                    variant="outline"
                    onClick={() => {
                      controller.setPanelOpen(true)
                      controller.setSection("recording")
                      controller.setTab("transcript")
                      controller.seek(18)
                    }}
                  >
                    {label("审阅转录", "Review transcript")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => controller.openArtifact("social")}
                  >
                    {label("创建社交草稿", "Create social draft")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => sourceInput.current?.click()}
                  >
                    {label("添加来源", "Add source")}
                  </Button>
                </div>
              </>
            )}
          </ThreadMessage>
        )}
      />
      <LocalArtifactPreview
        controller={controller}
        messageId="conversation-8-answer"
      />
    </>
  )
}
