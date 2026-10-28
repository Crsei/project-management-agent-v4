"use client"
import { useI18n } from "../../lib/i18n-provider"
import { localizeStaticData } from "../../lib/i18n-core"

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type RefObject,
} from "react"
import { ArrowDown, ArrowLeft, ArrowRight, RotateCcw } from "lucide-react"
import styles from "./scroll-playground.module.css"

const motionQuery = "(prefers-reduced-motion: reduce)"
function subscribeMotion(callback: () => void) {
  const query = window.matchMedia(motionQuery)
  query.addEventListener("change", callback)
  return () => query.removeEventListener("change", callback)
}
function motionSnapshot() {
  return window.matchMedia(motionQuery).matches
}
function serverMotionSnapshot() {
  return true
}
function useReducedMotion() {
  return useSyncExternalStore(
    subscribeMotion,
    motionSnapshot,
    serverMotionSnapshot,
  )
}

// Read native scroll positions once per animation frame. No wheel interception.
function useScrollMetrics(ref: RefObject<HTMLDivElement | null>) {
  const [metrics, setMetrics] = useState({ top: 0, progress: 0 })
  useEffect(() => {
    const viewport = ref.current
    if (!viewport) return
    let frame = 0
    const update = () => {
      frame = 0
      const distance = viewport.scrollHeight - viewport.clientHeight
      setMetrics({
        top: viewport.scrollTop,
        progress:
          distance > 0
            ? Math.min(1, Math.max(0, viewport.scrollTop / distance))
            : 0,
      })
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(viewport)
    for (const child of viewport.children) observer.observe(child)
    viewport.addEventListener("scroll", schedule, { passive: true })
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      viewport.removeEventListener("scroll", schedule)
    }
  }, [ref])
  return metrics
}

function ScrollHint({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.hint}>
      <ArrowDown size={13} aria-hidden="true" />
      {children}
    </div>
  )
}

function TriggeredDemo() {
  const { t } = useI18n()

  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    const viewport = ref.current
    if (!viewport || reduced || !("IntersectionObserver" in window)) return
    const items = viewport.querySelectorAll<HTMLElement>("[data-reveal]")
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const target = entry.target as HTMLElement
          target.dataset.visible = "true"
          observer.unobserve(entry.target)
        }
      },
      { root: viewport, threshold: 0.2 },
    )
    for (const item of items) {
      item.dataset.visible = "false"
      observer.observe(item)
    }
    viewport.dataset.motion = "ready"
    return () => {
      observer.disconnect()
      delete viewport.dataset.motion
    }
  }, [reduced])

  return (
    <div
      ref={ref}
      className={`${styles.viewport} ${styles.revealViewport}`}
      role="region"
      aria-label={t(
        "scrollPlayground.scrollTriggeredDemoScrollDownToRevealCards",
      )}
      tabIndex={0}
    >
      <div className={styles.revealIntro}>
        <span className={styles.eyebrow}>GOOD THINGS TAKE A SCROLL</span>
        <h3>{t("scrollPlayground.everyEntranceJustInTime")}</h3>
        <ScrollHint>
          {t("scrollPlayground.scrollDownToDiscoverThreeCards")}
        </ScrollHint>
      </div>
      <div className={styles.revealList}>
        {[
          [
            "01",
            t("scrollPlayground.aLittleInspiration"),
            t("scrollPlayground.startWithASmallIdea"),
            "✳",
          ],
          [
            "02",
            t("scrollPlayground.aLittleSurprise"),
            t("scrollPlayground.onceInViewTheAnimationPlaysToCompletion"),
            "↗",
          ],
          [
            "03",
            t("scrollPlayground.justEnough"),
            t("scrollPlayground.scrollBackTheCardsAreStillHere"),
            "◒",
          ],
        ].map(([number, title, text, mark]) => (
          <div key={number} className={styles.revealItem} data-reveal>
            <span className={styles.revealMark} aria-hidden="true">
              {mark}
            </span>
            <div>
              <span className={styles.micro}>{number} / DISCOVER</span>
              <h4>{title}</h4>
              <p>{text}</p>
            </div>
          </div>
        ))}
        <p className={styles.endNote}>
          {t("scrollPlayground.allRevealedScrollingUpDoesNotReplay")}
        </p>
      </div>
    </div>
  )
}

function LinkedDemo() {
  const { t } = useI18n()

  const ref = useRef<HTMLDivElement>(null)
  const { progress } = useScrollMetrics(ref)
  const percent = Math.round(progress * 100)
  return (
    <div
      ref={ref}
      className={`${styles.viewport} ${styles.readingViewport}`}
      role="region"
      aria-label={t(
        "scrollPlayground.scrollLinkedDemoReadingProgressFollowsArticleScrolling",
      )}
      tabIndex={0}
    >
      <div className={styles.readingToolbar}>
        <span className={styles.micro}>THE SLOW JOURNAL</span>
        <output className={styles.readingPercent}>
          {t("scrollPlayground.read")}
          {percent}%
        </output>
        <div
          className={styles.progressTrack}
          role="progressbar"
          aria-label={t("scrollPlayground.demoArticleReadingProgress")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className={styles.progressFill}
            style={{ transform: `scaleX(${progress})` }}
          />
        </div>
      </div>
      <article className={styles.readingArticle}>
        <span className={styles.eyebrow}>
          {t("scrollPlayground.vol02OnSlowingDown")}
        </span>
        <h3>
          {t("scrollPlayground.betweenScrolls")}
          <br />
          {t("scrollPlayground.leaveRoomToBreathe")}
        </h3>
        <p className={styles.readingLead}>
          {t("scrollPlayground.readOnTheFineLineAboveFollowsYour")}
        </p>
        <div className={styles.readingArt} aria-hidden="true">
          <span>
            slow
            <br />
            is a<br />
            <i>rhythm.</i>
          </span>
          <div />
        </div>
        {[
          [
            t("scrollPlayground.01SetYourOwnPace"),
            t(
              "scrollPlayground.aGoodReadingExperienceLetsContentUnfoldNaturally",
            ),
          ],
          [
            t("scrollPlayground.02LookBackAnytime"),
            t("scrollPlayground.tryScrollingUpProgressRetracesItsPathWithout"),
          ],
          [
            t("scrollPlayground.03ReachTheEnd"),
            t("scrollPlayground.whenTheLineIsFullThisShortArticle"),
          ],
        ].map(([title, text]) => (
          <section key={title}>
            <h4>{title}</h4>
            <p>{text}</p>
          </section>
        ))}
        <p className={styles.endNote}>END OF THE JOURNAL</p>
      </article>
    </div>
  )
}

function ParallaxDemo() {
  const { t } = useI18n()

  const ref = useRef<HTMLDivElement>(null)
  const { top } = useScrollMetrics(ref)
  const reduced = useReducedMotion()
  return (
    <div
      ref={ref}
      className={`${styles.viewport} ${styles.parallaxViewport}`}
      role="region"
      aria-label={t(
        "scrollPlayground.parallaxDemoCompareBackgroundAndForegroundScrollingSpeeds",
      )}
      tabIndex={0}
    >
      <div className={styles.parallaxScene}>
        <div
          className={styles.parallaxBackground}
          data-parallax-background
          aria-hidden="true"
          style={{ transform: `translateY(${reduced ? 0 : top * 0.65}px)` }}
        >
          <span className={styles.sun} />
          <span className={styles.mountainBack} />
          <span className={styles.mountainFront} />
        </div>
        <div className={styles.parallaxForeground}>
          <span className={styles.landscapeLabel}>A LITTLE FURTHER</span>
          <h3 data-parallax-foreground>
            {t("scrollPlayground.distantMountains")}
            <br />
            {t("scrollPlayground.aMomentCloseBy")}
          </h3>
          <ScrollHint>
            {t("scrollPlayground.scrollDownToSeeTheDistantMountains")}
          </ScrollHint>
          <div className={styles.landscapeNote}>
            <span className={styles.micro}>SAME SCROLL, DIFFERENT SPEEDS</span>
            <h4>{t("scrollPlayground.nearThingsPassDistantThingsDrift")}</h4>
            <p>
              {t("scrollPlayground.textScrollsAtNormalSpeedWhileTheBackground")}
            </p>
            <span className={styles.speedBadge}>
              {reduced
                ? t(
                    "scrollPlayground.reducedMotionBackgroundScrollsNormallyWithContent",
                  )
                : t("scrollPlayground.background035Foreground1")}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

const contacts = [
  {
    letter: "A",
    names: [
      ["安然", "产品设计"],
      ["艾米", "视觉设计"],
      ["阿泽", "前端开发"],
      ["安琪", "内容策划"],
    ],
  },
  {
    letter: "B",
    names: [
      ["白露", "交互设计"],
      ["柏川", "品牌设计"],
      ["贝拉", "产品经理"],
      ["北辰", "前端开发"],
    ],
  },
  {
    letter: "C",
    names: [
      ["陈一", "创意开发"],
      ["程可", "动效设计"],
      ["初夏", "用户研究"],
      ["崔宁", "内容设计"],
    ],
  },
]

function StickyDemo() {
  const { t } = useI18n()

  return (
    <div
      className={`${styles.viewport} ${styles.contactsViewport}`}
      role="region"
      aria-label={t(
        "scrollPlayground.stickyDemoAlphabetHeadersStickWhileYouScroll",
      )}
      tabIndex={0}
    >
      <div className={styles.contactsIntro}>
        <span className={styles.micro}>THE PEOPLE BOOK</span>
        <h3>{t("scrollPlayground.makeSomethingGoodTogether")}</h3>
        <p>{t("scrollPlayground.12TeammatesGroupedByName")}</p>
      </div>
      {contacts.map(({ letter, names }) => (
        <section key={letter} className={styles.contactGroup}>
          <h4 className={styles.stickyLetter} data-sticky-letter={letter}>
            <span>{letter}</span>
            <span>{t("scrollPlayground.4Teammates")}</span>
          </h4>
          {names.map(([name, role], index) => (
            <div key={name} className={styles.contact}>
              <span
                className={styles.avatar}
                data-color={index % 3}
                aria-hidden="true"
              >
                {name.slice(0, 1)}
              </span>
              <div>
                <p>{name}</p>
                <span>{role}</span>
              </div>
              <span
                className={styles.contactDot}
                aria-label={t("scrollPlayground.online")}
              />
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

const snapSlides = [
  {
    word: "PAUSE.",
    title: "停一停。",
    text: "让每一屏，都有自己的时间。",
    tone: "peach",
    mark: "◒",
  },
  {
    word: "BREATHE.",
    title: "深呼吸。",
    text: "松开滚轮，画面会自动对齐。",
    tone: "sage",
    mark: "✳",
  },
  {
    word: "BEGIN.",
    title: "再出发。",
    text: "下一段故事，从完整的一屏开始。",
    tone: "lilac",
    mark: "↗",
  },
]

function SnapDemo() {
  const { t } = useI18n()

  const ref = useRef<HTMLDivElement>(null)
  const { progress } = useScrollMetrics(ref)
  const reduced = useReducedMotion()
  const active = Math.round(progress * (snapSlides.length - 1))
  const goTo = (index: number) => {
    const viewport = ref.current
    if (!viewport) return
    viewport.scrollTo({
      top: index * viewport.clientHeight,
      behavior: reduced ? "instant" : "smooth",
    })
  }
  return (
    <div className={styles.snapDemo}>
      <div
        ref={ref}
        className={`${styles.viewport} ${styles.snapViewport}`}
        role="region"
        aria-label={t("scrollPlayground.scrollSnapDemoScrollingAlignsToAFull")}
        tabIndex={0}
      >
        {snapSlides.map(({ word, title, text, tone, mark }, index) => (
          <section
            key={word}
            className={styles.snapSlide}
            data-tone={tone}
            aria-label={t("common.screenValueValue", {
              value0: index + 1,
              value1: title,
            })}
          >
            <span className={styles.snapNumber}>0{index + 1} / 03</span>
            <span className={styles.snapMark} aria-hidden="true">
              {mark}
            </span>
            <div>
              <span className={styles.snapWord}>{word}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          </section>
        ))}
      </div>
      <div className={styles.snapControls}>
        <button
          type="button"
          aria-label={t("scrollPlayground.previousScreen")}
          onClick={() => goTo(active - 1)}
          disabled={active === 0}
        >
          <ArrowLeft size={14} />
        </button>
        <div className={styles.snapDots}>
          {snapSlides.map((slide, index) => (
            <button
              key={slide.word}
              type="button"
              aria-label={t("common.goToScreenValue", { value0: index + 1 })}
              aria-pressed={index === active}
              onClick={() => goTo(index)}
            >
              <span />
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label={t("scrollPlayground.nextScreen")}
          onClick={() => goTo(active + 1)}
          disabled={active === snapSlides.length - 1}
        >
          <ArrowRight size={14} />
        </button>
      </div>
    </div>
  )
}

const horizontalCards = [
  {
    name: "找寻",
    english: "EXPLORE",
    tone: "lilac",
    mark: "✳",
    text: "让好奇心带路",
  },
  {
    name: "连接",
    english: "CONNECT",
    tone: "sage",
    mark: "∞",
    text: "把灵感连成线",
  },
  {
    name: "创造",
    english: "CREATE",
    tone: "peach",
    mark: "◈",
    text: "让想法有形状",
  },
  {
    name: "出发",
    english: "GO BEYOND",
    tone: "blue",
    mark: "↗",
    text: "下一站，更多可能",
  },
]

function HorizontalDemo() {
  const { t } = useI18n()

  const ref = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const { progress } = useScrollMetrics(ref)
  const reduced = useReducedMotion()
  const [size, setSize] = useState({ distance: 0, height: 300 })

  useEffect(() => {
    const viewport = ref.current
    const track = trackRef.current
    if (!viewport || !track) return
    let frame = 0
    const measure = () => {
      frame = 0
      setSize({
        distance: Math.max(0, track.scrollWidth - viewport.clientWidth),
        height: viewport.clientHeight,
      })
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(viewport)
    observer.observe(track)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  return (
    <div
      ref={ref}
      className={`${styles.viewport} ${styles.horizontalViewport}`}
      data-reduced-motion={reduced}
      role="region"
      aria-label={
        reduced
          ? t("scrollPlayground.horizontalScrollDemoScrollRightToViewCards")
          : t("scrollPlayground.horizontalScrollDemoScrollDownToMoveCards")
      }
      tabIndex={0}
    >
      <div
        className={styles.horizontalRunway}
        style={{ height: reduced ? "100%" : size.height + size.distance }}
      >
        <div className={styles.horizontalSticky}>
          <div className={styles.horizontalLabel}>
            <span className={styles.micro}>SCROLL DOWN. GO SIDEWAYS.</span>
            <span>
              {reduced
                ? t("scrollPlayground.swipeRight")
                : t("scrollPlayground.scrollDown")}
            </span>
          </div>
          <div
            ref={trackRef}
            className={styles.horizontalTrack}
            data-horizontal-track
            style={{
              transform: reduced
                ? undefined
                : `translateX(${-progress * size.distance}px)`,
            }}
          >
            {horizontalCards.map(
              ({ name, english, tone, mark, text }, index) => (
                <article
                  key={name}
                  className={styles.horizontalCard}
                  data-tone={tone}
                >
                  <span className={styles.micro}>
                    0{index + 1} / {english}
                  </span>
                  <span className={styles.horizontalMark} aria-hidden="true">
                    {mark}
                  </span>
                  <div>
                    <h3>
                      {name}
                      <ArrowRight size={18} aria-hidden="true" />
                    </h3>
                    <p>{text}</p>
                  </div>
                </article>
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export type ScrollPattern =
  "triggered" | "linked" | "parallax" | "sticky" | "snap" | "horizontal"

const patterns: {
  id: ScrollPattern
  name: string
  label: string
  description: string
  technique: string
  Preview: ComponentType
}[] = [
  {
    id: "triggered",
    name: "Scroll-triggered",
    label: "进入，就播放",
    description: "卡片滚进视野后，自动完成淡入。停下滚动，动画也会继续。",
    technique: "IntersectionObserver · 触发一次",
    Preview: TriggeredDemo,
  },
  {
    id: "linked",
    name: "Scroll-linked",
    label: "滚多少，动多少",
    description: "阅读进度与滚动位置同步。向上回看，进度也跟着退回。",
    technique: "scrollTop / 可滚动距离",
    Preview: LinkedDemo,
  },
  {
    id: "parallax",
    name: "Parallax",
    label: "远景，慢一点",
    description: "前景文字正常滚动，背景缓慢移动，让平面有了纵深。",
    technique: "不同图层 · 不同速度",
    Preview: ParallaxDemo,
  },
  {
    id: "sticky",
    name: "Sticky",
    label: "到顶，就留下",
    description: "字母标题滚到顶部就钉住，直到下一组把它接替。",
    technique: "position: sticky · 分组吸顶",
    Preview: StickyDemo,
  },
  {
    id: "snap",
    name: "Scroll Snap",
    label: "每一屏，都到位",
    description: "滚动松手后自动吸附到完整的一屏，也可以用箭头切换。",
    technique: "scroll-snap-type: y mandatory",
    Preview: SnapDemo,
  },
  {
    id: "horizontal",
    name: "Horizontal Scroll",
    label: "向下滚，横着走",
    description: "继续向下滚动，卡片沿横向展开。滚回去，它们就沿原路返回。",
    technique: "Sticky + translateX · 原生纵向滚动",
    Preview: HorizontalDemo,
  },
]

function DemoCard({
  pattern,
  index,
  id,
}: {
  pattern: (typeof patterns)[number]
  index: number
  id: string
}) {
  const { t } = useI18n()

  const [iteration, setIteration] = useState(0)
  const { name, label, description, technique, Preview } = pattern
  return (
    <article id={id} className={styles.card} aria-labelledby={`${id}-title`}>
      <div className={styles.cardHeader}>
        <div className={styles.cardTitle}>
          <span className={styles.index}>0{index + 1}</span>
          <div>
            <h2 id={`${id}-title`}>{name}</h2>
            <p>{label}</p>
          </div>
        </div>
        <button
          type="button"
          className={styles.reset}
          aria-label={t("common.resetValueDemo", { value0: name })}
          title={t("scrollPlayground.tryAgain")}
          onClick={() => setIteration((value) => value + 1)}
        >
          <RotateCcw size={15} aria-hidden="true" />
        </button>
      </div>
      <Preview key={iteration} />
      <div className={styles.cardFooter}>
        <p>{description}</p>
        <span className={styles.technique}>{technique}</span>
      </div>
    </article>
  )
}

export type ScrollPlaygroundProps = {
  /** Optional prefix for linking directly to each pattern, e.g. #scroll-sticky. */
  idPrefix?: string
  /** Show one pattern instead of the complete collection. */
  pattern?: ScrollPattern
  className?: string
}

/** Six independent, keyboard-focusable native scroll experiments. */
export function ScrollPlayground({
  idPrefix,
  pattern: selectedPattern,
  className,
}: ScrollPlaygroundProps) {
  const { locale } = useI18n()

  const localizedPatterns = localizeStaticData(patterns, locale)

  const generatedId = useId()
  const prefix = idPrefix || generatedId
  return (
    <div className={`${styles.grid}${className ? ` ${className}` : ""}`}>
      {localizedPatterns.map((pattern, index) =>
        !selectedPattern || selectedPattern === pattern.id ? (
          <DemoCard
            key={pattern.id}
            pattern={pattern}
            index={index}
            id={`${prefix}-${pattern.id}`}
          />
        ) : null,
      )}
    </div>
  )
}
