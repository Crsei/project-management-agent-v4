"use client"
import { useId, useRef } from "react"
import { Check, Copy, ExternalLink, Search } from "lucide-react"
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui"
import { CitationList, CitationPreview, InlineCitation } from "./citations"
import { ConversationInput } from "./input"
import { ThreadActivity, ThreadMessage, ThreadView } from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation22Controller } from "./conversation-22-controller"
import styles from "./conversation-22.module.css"

const researchImages = [
  { id: "features", zh: "功能展示", en: "Feature showcase" },
  { id: "pricing", zh: "定价区块", en: "Pricing section" },
  { id: "testimonials", zh: "用户评价", en: "Testimonials" },
  { id: "layout", zh: "功能布局", en: "Feature layout" },
] as const

function ResearchIllustration({
  kind,
  label,
}: {
  kind: NonNullable<Conversation22Controller["imageId"]>
  label: string
}) {
  const id = useId()
  return (
    <svg
      role="img"
      aria-labelledby={id}
      viewBox="0 0 240 144"
      className={styles.illustration}
    >
      <title id={id}>{label}</title>
      <rect
        x="1"
        y="1"
        width="238"
        height="142"
        rx="10"
        fill="var(--background)"
        stroke="var(--border)"
      />
      {kind === "features" && (
        <>
          <text
            x="16"
            y="28"
            fill="currentColor"
            fontSize="11"
            fontWeight="600"
          >
            One workspace, composed
          </text>
          <rect
            x="16"
            y="40"
            width="92"
            height="86"
            rx="6"
            fill="var(--muted)"
          />
          <text x="24" y="60" fill="currentColor" fontSize="9">
            Source-first
          </text>
          <text x="24" y="78" fill="var(--muted-foreground)" fontSize="8">
            React + Tailwind
          </text>
          <path
            d="M24 92h64M24 102h48M24 112h56"
            stroke="var(--border)"
            strokeWidth="3"
          />
          <rect
            x="120"
            y="40"
            width="104"
            height="40"
            rx="6"
            fill="var(--muted)"
          />
          <text x="130" y="62" fill="currentColor" fontSize="9">
            Reusable sections
          </text>
          <rect
            x="120"
            y="88"
            width="104"
            height="38"
            rx="6"
            fill="var(--muted)"
          />
          <text x="130" y="111" fill="currentColor" fontSize="9">
            Adapt the source
          </text>
        </>
      )}
      {kind === "pricing" && (
        <>
          <text
            x="16"
            y="24"
            fill="currentColor"
            fontSize="11"
            fontWeight="600"
          >
            Three-plan layout study
          </text>
          {["Starter", "Team", "Scale"].map((name, index) => (
            <g key={name}>
              <rect
                x={16 + index * 72}
                y="38"
                width="64"
                height="90"
                rx="6"
                fill={index === 1 ? "var(--muted)" : "var(--background)"}
                stroke="var(--border)"
              />
              <text x={24 + index * 72} y="55" fill="currentColor" fontSize="9">
                {name}
              </text>
              <text
                x={24 + index * 72}
                y="71"
                fill="var(--muted-foreground)"
                fontSize="8"
              >
                Layout only
              </text>
              <path
                d={`M${24 + index * 72} 82h44M${24 + index * 72} 92h36`}
                stroke="var(--border)"
                strokeWidth="2"
              />
              <rect
                x={24 + index * 72}
                y="105"
                width="48"
                height="13"
                rx="3"
                fill="var(--foreground)"
              />
            </g>
          ))}
        </>
      )}
      {kind === "testimonials" && (
        <>
          <text
            x="16"
            y="24"
            fill="currentColor"
            fontSize="11"
            fontWeight="600"
          >
            Stories from product teams
          </text>
          {[0, 1, 2].map((index) => (
            <g key={index}>
              <rect
                x={16 + index * 72}
                y="38"
                width="64"
                height="90"
                rx="6"
                fill="var(--muted)"
              />
              <text
                x={24 + index * 72}
                y="58"
                fill="currentColor"
                fontSize="18"
              >
                “
              </text>
              <path
                d={`M${24 + index * 72} 68h44M${24 + index * 72} 78h38M${24 + index * 72} 88h32`}
                stroke="var(--border)"
                strokeWidth="3"
              />
              <circle
                cx={30 + index * 72}
                cy="112"
                r="6"
                fill="var(--muted-foreground)"
              />
              <text
                x={41 + index * 72}
                y="115"
                fill="currentColor"
                fontSize="7"
              >
                Team {index + 1}
              </text>
            </g>
          ))}
        </>
      )}
      {kind === "layout" && (
        <>
          <text
            x="16"
            y="24"
            fill="currentColor"
            fontSize="11"
            fontWeight="600"
          >
            A coordinated feature grid
          </text>
          {["Compose", "Customize", "Integrate", "Iterate"].map(
            (name, index) => (
              <g key={name}>
                <rect
                  x={16 + (index % 2) * 108}
                  y={38 + Math.floor(index / 2) * 48}
                  width="100"
                  height="40"
                  rx="6"
                  fill="var(--muted)"
                />
                <circle
                  cx={28 + (index % 2) * 108}
                  cy={58 + Math.floor(index / 2) * 48}
                  r="4"
                  fill="var(--muted-foreground)"
                />
                <text
                  x={40 + (index % 2) * 108}
                  y={61 + Math.floor(index / 2) * 48}
                  fill="currentColor"
                  fontSize="9"
                >
                  {name}
                </text>
              </g>
            ),
          )}
        </>
      )}
    </svg>
  )
}

export function Conversation22View({
  controller,
  host,
}: {
  controller: Conversation22Controller
  host: ComposerHost
}) {
  const { label, copy, fixture, history: historyRef } = controller
  const sourceSection = useRef<HTMLDivElement>(null)
  const imageFocus = useRef<HTMLElement | null>(null)
  const hasArticle = controller.selected.messages.some(
    (message) => message.id === "web-answer-answer",
  )
  const selectedImage = researchImages.find(
    (image) => image.id === controller.imageId,
  )
  const body = (
    <div className={styles.document}>
      <div
        ref={historyRef}
        className={styles.scroll}
        onScroll={controller.rememberPosition}
        role="region"
        aria-label={label(
          "研究答复与后续消息",
          "Research answer and follow-ups",
        )}
      >
        <div className={styles.article}>
          {hasArticle ? (
            <>
              <div className={styles.meta}>
                <span>{label("网页答复", "Web answer")}</span>
                <span>·</span>
                <span>
                  {label("来源记录日期", "Saved research date")}{" "}
                  <time dateTime={fixture.savedDate}>{fixture.savedDate}</time>{" "}
                  {label("（固定示例）", "(fixed fixture)")}
                </span>
              </div>
              <h1 className={styles.title}>{copy(fixture.question)}</h1>
              <div className={styles.prelude}>
                <ThreadActivity
                  title={`${label("研究", "Research")} · ${fixture.researchSteps.length} ${label("步骤已完成", "steps completed")}`}
                  defaultOpen={false}
                >
                  <ol className="grid gap-2">
                    {fixture.researchSteps.map((step, index) => (
                      <li key={index} className="flex items-center gap-2">
                        <Check size={14} aria-hidden="true" />
                        {copy(step)}
                      </li>
                    ))}
                  </ol>
                  <small>
                    {label(
                      "参考页固定轨迹；未执行实时搜索。",
                      "Fixed reference trace; no live search was executed.",
                    )}
                  </small>
                </ThreadActivity>
                <div ref={sourceSection} className={styles.sources}>
                  <div className={styles.sourcesHeader}>
                    <h2>{label("来源", "Sources")}</h2>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={controller.sourcesOpen}
                      onClick={() =>
                        controller.setSourcesOpen((value) => !value)
                      }
                    >
                      {controller.sourcesOpen
                        ? label("只显示前三个来源", "Show first three sources")
                        : label("查看全部 5 个来源", "View all 5 sources")}
                    </Button>
                  </div>
                  <div className={styles.sourceCards}>
                    <CitationList
                      controller={controller}
                      variant="cards"
                      limit={controller.sourcesOpen ? undefined : 3}
                    />
                  </div>
                </div>
              </div>
              <div className={styles.articleGrid}>
                <article
                  className={styles.answer}
                  aria-label={label(
                    "带引用的研究答复",
                    "Cited research answer",
                  )}
                >
                  <h2 className={styles.answerHeading}>
                    {label("答复", "Answer")}
                  </h2>
                  <p>
                    {copy(fixture.summary.text)}
                    <InlineCitation
                      controller={controller}
                      sourceId={fixture.summary.sourceId}
                    />
                  </p>
                  {fixture.sections.map((section) => (
                    <section key={section.id}>
                      <h2>{copy(section.title)}</h2>
                      {section.items.map((item, index) => (
                        <div key={index}>
                          {item.title && <h3>{copy(item.title)}</h3>}
                          <p>
                            {copy(item.paragraph.text)}
                            <InlineCitation
                              controller={controller}
                              sourceId={item.paragraph.sourceId}
                            />
                          </p>
                        </div>
                      ))}
                    </section>
                  ))}
                  <p className={styles.note}>
                    {label(
                      "右侧为本地原创布局示意，不复制原站付费图片。打开来源可查看产品实际预览与安装说明。",
                      "The right-hand previews are original local layout illustrations, not copied premium images. Open a source for actual product previews and installation details.",
                    )}
                  </p>
                  <div className={styles.answerActions}>
                    <Button variant="ghost" onClick={controller.copyAnswer}>
                      <Copy />
                      {label("复制答复与来源", "Copy answer and sources")}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        controller.setSourcesOpen(true)
                        sourceSection.current?.scrollIntoView({
                          block: "nearest",
                        })
                      }}
                    >
                      <Search />
                      {label("检查来源", "Inspect sources")}
                    </Button>
                    {controller.copyState !== "idle" && (
                      <span
                        role={
                          controller.copyState === "error" ? "alert" : "status"
                        }
                      >
                        {controller.copyState === "copied"
                          ? label(
                              "已复制完整答复与 5 个 URL",
                              "Copied the full answer and five URLs",
                            )
                          : label(
                              "复制失败，请手动选择答复。",
                              "Copy failed; select the answer manually.",
                            )}
                      </span>
                    )}
                  </div>
                  <section className={styles.followUps}>
                    <h2>{label("继续了解这些来源", "Explore the sources")}</h2>
                    {fixture.followUps.map((item) => (
                      <Button
                        key={item.id}
                        variant="outline"
                        disabled={!controller.canSend}
                        onClick={() => controller.followUp(item.id)}
                      >
                        {copy(item.question)}
                      </Button>
                    ))}
                  </section>
                </article>
                <aside
                  className={styles.images}
                  aria-label={label("图像与产品", "Images and product")}
                >
                  <h2>{label("图像", "Images")}</h2>
                  <small>
                    {label(
                      "本地原创布局示意",
                      "Original local layout illustrations",
                    )}
                  </small>
                  {researchImages.map((image) => (
                    <Button
                      key={image.id}
                      variant="outline"
                      className={styles.imageButton}
                      onClick={(event) => {
                        imageFocus.current = event.currentTarget
                        controller.setImageId(image.id)
                      }}
                    >
                      <span className="sr-only">{label("放大", "Enlarge")}</span>
                      <ResearchIllustration
                        kind={image.id}
                        label={label(image.zh, image.en)}
                      />
                      <span>{label(image.zh, image.en)}</span>
                    </Button>
                  ))}
                  <div className={styles.product}>
                    <h3>{label("探索产品", "Explore the product")}</h3>
                    <strong>Shadcn Admin Kit</strong>
                    <p>
                      {label(
                        "面向仪表盘和工作区的应用界面基础。",
                        "An application interface foundation for dashboards and workspaces.",
                      )}
                    </p>
                    <Button asChild variant="outline">
                      <a
                        href="https://www.shadcnblocks.com/template/admin"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {label("查看原始产品", "View original product")}
                        <ExternalLink />
                      </a>
                    </Button>
                  </div>
                </aside>
              </div>
            </>
          ) : (
            <div className={styles.empty}>
              <h1>{label("网页资料答复", "Web notes answer")}</h1>
              <p>
                {label(
                  "输入一个关于区块、模板或安装的问题，在五份保存的来源中查找相关摘记。",
                  "Ask about blocks, templates or installation to find relevant notes in five saved sources.",
                )}
              </p>
            </div>
          )}
          <div className={styles.followUpHistory}>
            {controller.selected.messages
              .filter(
                (message) =>
                  !fixture.source.sessions[0].messages.some(
                    (original) => original.id === message.id,
                  ),
              )
              .map((message) => (
                <ThreadMessage
                  key={message.id}
                  message={message}
                  controller={controller}
                />
              ))}
          </div>
        </div>
      </div>
      <div className={styles.inputDock}>
        <ConversationInput
          controller={controller}
          options={{
            appearance: "compact",
            showModelControl: false,
            showContextReferences: false,
            hideSuggestion: true,
            leadingAction: (
              <Button
                variant="ghost"
                size="icon"
                aria-label={label("查看保存来源", "Inspect saved sources")}
                onClick={() => {
                  controller.setSourcesOpen(true)
                  sourceSection.current?.scrollIntoView({ block: "nearest" })
                }}
              >
                <Search />
              </Button>
            ),
            placeholder: {
              "zh-CN": "对这些来源继续提问…",
              en: "Ask a follow-up about these sources…",
            },
            textareaProps: { rows: 1 },
          }}
        />
        <p>
          {label(
            "跟进问题只查找五份保存来源中的相关摘记，不执行实时搜索。",
            "Follow-ups find relevant passages in the five saved sources; no live search.",
          )}
        </p>
      </div>
      {controller.refreshError && (
        <p role="alert" className="px-8 pb-3 text-sm text-destructive">
          {label(
            "来源刷新失败，现有答复、来源与草稿保留。请再次点击明确重试本地读取。",
            "Source refresh failed; answer, sources and draft are preserved. Click again to retry the local read explicitly.",
          )}
        </p>
      )}
    </div>
  )
  return (
    <>
      <ThreadView
        page="web-answer"
        controller={controller}
        host={host}
        title={fixture.question}
        showSessionNavigation={false}
        layout="document"
        body={body}
        headerActions={
          <Button variant="ghost" onClick={controller.refresh}>
            {label("刷新本地来源", "Refresh local sources")}
          </Button>
        }
        beforeInput={
          controller.refreshError && (
            <p role="alert">
              {label(
                "来源刷新失败，现有内容与草稿保留。",
                "Source refresh failed; content and draft are preserved.",
              )}
            </p>
          )
        }
        renderMessage={(message) => (
          <ThreadMessage message={message} controller={controller} />
        )}
      />
      <CitationPreview controller={controller} />
      <Dialog
        open={Boolean(selectedImage) && controller.active}
        onOpenChange={(open) => {
          if (!open) controller.setImageId(null)
        }}
      >
        <DialogContent
          className="sm:max-w-3xl"
          onCloseAutoFocus={(event) => {
            if (controller.active && imageFocus.current?.isConnected) {
              event.preventDefault()
              imageFocus.current.focus({ preventScroll: true })
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {selectedImage
                ? label(selectedImage.zh, selectedImage.en)
                : label("图像", "Image")}
            </DialogTitle>
            <DialogDescription>
              {label(
                "本地原创布局示意，不是原站截图或实际报价。",
                "Original local layout illustration, not an upstream screenshot or actual pricing.",
              )}
            </DialogDescription>
          </DialogHeader>
          {selectedImage && (
            <ResearchIllustration
              kind={selectedImage.id}
              label={label(selectedImage.zh, selectedImage.en)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
