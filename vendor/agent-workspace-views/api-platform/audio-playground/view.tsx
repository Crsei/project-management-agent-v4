"use client"

import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  Braces,
  Download,
  Headphones,
  Mic,
  Pause,
  Play,
  Square,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@easyuse-ui/ui/components/ui/card"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Slider } from "@easyuse-ui/ui/components/ui/slider"
import { Switch } from "@easyuse-ui/ui/components/ui/switch"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import {
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel,
} from "@easyuse-ui/ui/components/ui/tabs"
import { CodePreview } from "@easyuse-ui/ui/components/blocks/code-preview"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { ApPage, ApSelect } from "../shared"
import { useApCache, useApState } from "../state"
import { apAsOf, apScenarios, type ApScenario } from "../model"
import type { RemainingPageProps } from "../../showcase/model"
import {
  audioAssetBase,
  audioAssetLicense,
  audioModes,
  audioSamples,
  audioSpeeds,
  audioVoices,
  type AudioMode,
  type AudioSampleId,
  type AudioVoice,
} from "./fixtures"
import {
  audioAssetUrl,
  audioClock,
  audioRequest,
  beginAudioSession,
  cancelAudioSession,
  audioSessionMatchesSelection,
  createAudioState,
  resolveAudioSession,
  selectedAudioAsset,
  sessionTranscript,
  type AudioFailure,
  type AudioOutcome,
  type AudioState,
} from "./controller"
import styles from "./audio-playground.module.css"

function Setting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.setting} role="group" aria-label={label}>
      <span className={styles.label}>{label}</span>
      {children}
    </div>
  )
}

export const pageScenarios = apScenarios

export function RemainingPageView({ scenario, active }: RemainingPageProps) {
  return (
    <AudioPlaygroundView scenario={scenario as ApScenario} active={active} />
  )
}

export function AudioPlaygroundView({
  scenario,
  active = true,
}: {
  scenario: ApScenario
  active?: boolean
}) {
  const { locale } = useI18n()
  const copy = (en: string, zh: string) => (locale === "en" ? en : zh)
  const cache = useApCache()
  const [state, setState] = useApState<AudioState>(
    `audio-playground:${scenario}`,
    () => createAudioState(scenario),
  )
  const player = useRef<HTMLAudioElement>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const inspectorBody = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const sourcePlayRequested = useRef(false)
  const previousOperationResult = useRef(state.operation?.result)
  const playGeneration = useRef(0)
  const [playback, setPlayback] = useState<
    "ready" | "loading" | "playing" | "paused" | "error" | "blocked"
  >("loading")
  const [position, setPosition] = useState(0)
  const [sourcePreview, setSourcePreview] = useState(false)
  const [exported, setExported] = useState(false)
  const readonly = scenario === "readonly"
  const pending = state.operation?.result === "pending"
  const unknown = state.operation?.result === "unknown"
  const busy = pending || unknown
  const translated =
    state.mode === "translate" && !!state.session?.translated && !sourcePreview
  const asset = selectedAudioAsset(state, translated)
  const url = audioAssetUrl(state, translated)
  const unavailable = scenario === "empty" || !state.loaded
  const src =
    !active || unavailable
      ? undefined
      : state.failure === "asset-error"
        ? `${audioAssetBase}/missing-fixture.wav`
        : url
  const editorKey =
    state.mode === "speech" ? `speech:${state.sample}` : "instructions"
  const request = audioRequest(state, scenario)
  const duration = asset.duration
  const peakMaximum = Math.max(...asset.peaks)
  const actualSession = audioSessionMatchesSelection(state)
    ? state.session
    : null

  function stop() {
    playGeneration.current++
    window.clearTimeout(timer.current)
    timer.current = undefined
    const audio = player.current
    if (audio) {
      audio.pause()
      audio.currentTime = 0
    }
    setPosition(0)
    setPlayback(src ? "ready" : "loading")
    setState(cancelAudioSession)
  }
  function change(patch: Partial<AudioState>) {
    stop()
    setSourcePreview(false)
    setState((before) => ({ ...before, ...patch, session: null }))
  }
  async function play() {
    const audio = player.current
    if (!active || !audio || unavailable || state.failure === "asset-error")
      return
    const generation = ++playGeneration.current
    if (state.failure === "blocked") {
      setPlayback("blocked")
      return
    }
    setPlayback("loading")
    try {
      audio.playbackRate = Number(state.speed)
      await audio.play()
      if (generation !== playGeneration.current) return
      setPlayback("playing")
    } catch (error) {
      if (generation !== playGeneration.current) return
      setPlayback(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "blocked"
          : "error",
      )
    }
  }
  function start() {
    if (!active || busy || readonly || unavailable || playback === "playing")
      return
    stop()
    setSourcePreview(false)
    const next = beginAudioSession(state, scenario)
    if (next === state || !next.operation) return
    setState(next)
    const operationId = next.operation.operationId
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      setState((before) =>
        resolveAudioSession(before, operationId, next.outcome),
      )
    }, 650)
  }
  function exportRequest() {
    const blob = new Blob(
      [JSON.stringify({ request, operation: state.operation }, null, 2)],
      { type: "application/json" },
    )
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = objectUrl
    link.download = `audio-${state.mode}-fixture-request.json`
    link.click()
    URL.revokeObjectURL(objectUrl)
    setExported(true)
  }

  const deactivate = useEffectEvent(() => {
    stop()
  })
  useEffect(() => {
    if (!active) return
    return () => deactivate()
  }, [active])
  const playFromEffect = useEffectEvent(() => {
    void play()
  })
  const playConfirmedFromEffect = useEffectEvent(() => {
    if (audioSessionMatchesSelection(state)) void play()
  })
  const restoreCaret = useEffectEvent(() => {
    const caret = state.caret[editorKey]
    if (caret && editor.current)
      editor.current.setSelectionRange(caret.start, caret.end)
  })
  const releasePlayer = useEffectEvent((audio: HTMLAudioElement) => {
    playGeneration.current++
    window.clearTimeout(timer.current)
    audio.pause()
    audio.removeAttribute("src")
    audio.load()
    setState(cancelAudioSession)
  })
  useEffect(() => {
    const audio = player.current
    if (!audio) return
    return () => releasePlayer(audio)
  }, [])
  useEffect(() => {
    const audio = player.current
    if (!audio) return
    playGeneration.current++
    audio.pause()
    setPosition(0)
    setPlayback(src ? "loading" : "ready")
    audio.load()
    if (sourcePlayRequested.current) {
      sourcePlayRequested.current = false
      playFromEffect()
    }
  }, [src, state.mode])
  useEffect(() => {
    if (player.current) player.current.playbackRate = Number(state.speed)
  }, [state.speed])
  useEffect(() => {
    const previous = previousOperationResult.current
    previousOperationResult.current = state.operation?.result
    if (
      (previous === "pending" || previous === "unknown") &&
      state.operation?.result === "confirmed"
    )
      playConfirmedFromEffect()
  }, [state.operation?.operationId, state.operation?.result])
  useLayoutEffect(() => {
    restoreCaret()
    if (inspectorBody.current)
      inspectorBody.current.scrollTop = Number(
        cache?.get(`audio-inspector:${state.inspector}`) ?? 0,
      )
  }, [editorKey, state.inspector, cache])

  const status = pending
    ? copy("Processing sample", "处理样例中")
    : unknown
      ? copy("Unknown result", "结果未知")
      : {
          ready: copy("Ready", "就绪"),
          loading: copy("Loading audio", "加载音频"),
          playing: copy("Playing", "播放中"),
          paused: copy("Paused", "已暂停"),
          error: copy("Audio unavailable", "音频不可用"),
          blocked: copy("Playback blocked", "播放受阻"),
        }[playback]
  const mainAction =
    state.mode === "speech"
      ? copy("Preview voice", "预览声音")
      : state.mode === "translate"
        ? copy("Translate sample", "翻译样例")
        : copy("Start demo session", "开始演示会话")
  const settingsTitle =
    state.mode === "speech"
      ? copy("Voice settings", "声音设置")
      : state.mode === "translate"
        ? copy("Translation setup", "翻译设置")
        : copy("Session settings", "会话设置")
  const speed = (
    <Setting label={copy("Playback speed", "播放速率")}>
      <ApSelect
        label={copy("Audio playback speed", "音频播放速率")}
        value={state.speed}
        onChange={(value) =>
          setState((before) => ({ ...before, speed: value }))
        }
        options={audioSpeeds.map((value) => ({ value, label: `${value}×` }))}
      />
    </Setting>
  )
  const settings = (
    <Card className={styles.card} data-audio-region="settings">
      <CardHeader className={styles.cardHeader}>
        <CardTitle className={styles.cardTitle} aria-level={2}>
          {settingsTitle}
        </CardTitle>
        <CardDescription className={styles.description}>
          {copy(
            "Prepare a request and try a sample.",
            "准备请求并体验固定样例。",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className={styles.cardContent}>
        <div className={styles.settingsFields}>
          {state.mode === "translate" ? (
            <>
              <Setting label={copy("Source language", "源语言")}>
                <p className={styles.staticValue}>
                  {copy("Spanish", "西班牙语")}
                </p>
              </Setting>
              <Setting label={copy("Target language", "目标语言")}>
                <p className={styles.staticValue}>{copy("English", "英语")}</p>
                <p className={styles.description}>
                  {copy(
                    "This sample asks about an order’s delivery date.",
                    "此样例询问订单的送达日期。",
                  )}
                </p>
              </Setting>
              <Button
                variant="outline"
                className={styles.sourceButton}
                disabled={unavailable || pending}
                onClick={() => {
                  stop()
                  if (translated) sourcePlayRequested.current = true
                  setSourcePreview(true)
                  if (!translated) void play()
                }}
              >
                <Play size={16} />
                {copy("Play source audio", "播放源音频")}
              </Button>
              {speed}
            </>
          ) : (
            <>
              <Setting label={copy("Sample scenario", "样例场景")}>
                <ApSelect
                  label={copy("Audio sample scenario", "音频样例场景")}
                  value={state.sample}
                  onChange={(value) =>
                    change({ sample: value as AudioSampleId })
                  }
                  options={Object.entries(audioSamples).map(
                    ([value, sample]) => ({
                      value,
                      label: sample.label[locale],
                    }),
                  )}
                  disabled={readonly || unavailable || pending}
                />
              </Setting>
              <Setting label={copy("Voice", "声音")}>
                <ApSelect
                  label={copy("Audio voice", "音频声音")}
                  value={state.voice}
                  onChange={(value) => change({ voice: value as AudioVoice })}
                  options={audioVoices.map((voice) => ({
                    value: voice.value,
                    label: voice.label[locale],
                  }))}
                  disabled={readonly || unavailable || pending}
                />
              </Setting>
              {speed}
              {state.mode === "realtime" && (
                <>
                  <div className={styles.divider} />
                  <Setting label={copy("Transport", "传输方式")}>
                    <ApSelect
                      label={copy("Realtime transport", "实时传输方式")}
                      value={state.transport}
                      onChange={(value) =>
                        setState((before) => ({
                          ...before,
                          transport: value as AudioState["transport"],
                        }))
                      }
                      options={[
                        { value: "webrtc", label: "WebRTC" },
                        { value: "websocket", label: "WebSocket" },
                      ]}
                      disabled={readonly || pending}
                    />
                  </Setting>
                  <Setting label={copy("Noise reduction", "降噪")}>
                    <ApSelect
                      label={copy("Noise reduction", "降噪")}
                      value={state.noiseReduction}
                      onChange={(value) =>
                        setState((before) => ({
                          ...before,
                          noiseReduction: value as AudioState["noiseReduction"],
                        }))
                      }
                      options={[
                        {
                          value: "near_field",
                          label: copy("Near field", "近场"),
                        },
                        {
                          value: "far_field",
                          label: copy("Far field", "远场"),
                        },
                        { value: "off", label: copy("Off", "关闭") },
                      ]}
                      disabled={readonly || pending}
                    />
                  </Setting>
                  <div className={styles.switchField}>
                    <label htmlFor="audio-turn-detection">
                      {copy("Automatic turn detection", "自动轮次检测")}
                    </label>
                    <Switch
                      id="audio-turn-detection"
                      checked={state.turnDetection}
                      onCheckedChange={(value) =>
                        setState((before) => ({
                          ...before,
                          turnDetection: value,
                        }))
                      }
                      disabled={readonly || pending}
                    />
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )

  const editorField = (
    <Field
      label={
        state.mode === "speech"
          ? copy("Speech script", "语音文稿")
          : copy("Instructions", "指令")
      }
      className={`${styles.editorField} ${state.mode === "speech" ? styles.hiddenLabel : ""}`}
    >
      {(props) => (
        <Textarea
          {...props}
          ref={editor}
          className={`${styles.textarea} ${state.mode === "speech" ? styles.script : ""}`}
          maxLength={4000}
          readOnly={readonly}
          value={
            state.mode === "speech"
              ? state.scripts[state.sample]
              : state.instructions
          }
          onChange={(event) => {
            const value = event.target.value
            setState((before) =>
              state.mode === "speech"
                ? {
                    ...before,
                    scripts: { ...before.scripts, [state.sample]: value },
                  }
                : { ...before, instructions: value },
            )
          }}
          onSelect={(event) => {
            const target = event.currentTarget
            setState((before) => ({
              ...before,
              caret: {
                ...before.caret,
                [editorKey]: {
                  start: target.selectionStart,
                  end: target.selectionEnd,
                },
              },
            }))
          }}
        />
      )}
    </Field>
  )
  return (
    <ApPage
      pageId="audio-playground"
      variant="reference"
      title={copy("Audio playground", "音频试验场")}
      description={copy(
        "Configure voice sessions, inspect transcripts, and preview speech.",
        "配置语音会话、查看转录并预览语音。",
      )}
      actions={
        <Button variant="outline" onClick={exportRequest}>
          <Braces size={16} />
          {copy("Export request", "导出请求")}
        </Button>
      }
    >
      <div className={styles.root}>
        <audio
          ref={player}
          src={src}
          preload="metadata"
          data-audio-player
          onLoadedMetadata={() =>
            setPlayback((before) => (before === "playing" ? before : "ready"))
          }
          onCanPlay={() =>
            setPlayback((before) => (before === "loading" ? "ready" : before))
          }
          onPlay={() => setPlayback("playing")}
          onPause={() =>
            setPlayback((before) => (before === "playing" ? "paused" : before))
          }
          onEnded={() => {
            setPlayback("ready")
            setPosition(duration)
            setState((before) => ({
              ...before,
              events: [
                ...before.events,
                {
                  at: duration,
                  name: "audio.playback.completed",
                  detail: `${audioClock(duration)} played`,
                },
              ],
            }))
          }}
          onError={() => setPlayback("error")}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        />
        {readonly && (
          <p className={styles.notice} role="status">
            {copy(
              "Read only · voice/request editing and sample execution are disabled. Local playback and speed remain available.",
              "只读 · 无法编辑语音请求或执行样例；仍可播放本地音频并调整播放速率。",
            )}
          </p>
        )}
        {scenario === "refresh-error" && !state.refreshed && (
          <p role="alert" className={styles.notice}>
            {copy(
              "Refresh failed. Keeping the existing samples and drafts.",
              "刷新失败，保留已有样例与草稿。",
            )}{" "}
            <Button
              variant="outline"
              onClick={() =>
                setState((before) => ({ ...before, refreshed: true }))
              }
            >
              {copy("Retry refresh", "重试刷新")}
            </Button>
          </p>
        )}
        <Tabs
          value={state.mode}
          onValueChange={(value) => change({ mode: value as AudioMode })}
        >
          <TabsList
            className={styles.tabsList}
            aria-label={copy("Audio mode", "音频模式")}
          >
            {audioModes.map((mode) => (
              <TabsTab
                className={styles.tab}
                key={mode.value}
                value={mode.value}
              >
                {mode.label[locale]}
              </TabsTab>
            ))}
          </TabsList>
          <TabsPanel value={state.mode} className={styles.modePanel}>
            <DataRegion
              state={
                scenario === "empty"
                  ? "empty"
                  : !state.loaded
                    ? "loading"
                    : "success"
              }
              emptyTitle={copy("No audio samples", "暂无音频样例")}
              emptyDescription={copy(
                "This fixture scenario has no recordings. Choose Default to try a sample.",
                "此场景没有录音，请选择默认场景体验样例。",
              )}
            >
              {
                <div className={styles.grid}>
                  {settings}
                  <div className={styles.previewColumn}>
                    {state.mode === "speech" ? (
                      <Card className={styles.card} data-audio-region="script">
                        <CardHeader className={styles.cardHeader}>
                          <CardTitle
                            className={styles.cardTitle}
                            aria-level={2}
                          >
                            {copy("Speech script", "语音文稿")}
                          </CardTitle>
                          <CardDescription className={styles.description}>
                            {copy(
                              "Voice playback uses the selected sample. Your edited script is included in request exports.",
                              "播放使用选中的固定样例；编辑后的文稿只包含在请求导出中，不会合成新语音。",
                            )}
                          </CardDescription>
                        </CardHeader>
                        <CardContent className={styles.cardContent}>
                          {editorField}
                          <p className={styles.scriptCaption}>
                            {state.scripts[state.sample].length}{" "}
                            {copy("characters · WAV output", "字符 · WAV 输出")}
                          </p>
                        </CardContent>
                      </Card>
                    ) : (
                      state.mode !== "translate" && editorField
                    )}
                    <Card className={styles.card} data-audio-region="player">
                      <CardHeader
                        className={`${styles.cardHeader} ${styles.playerHeader}`}
                      >
                        <div>
                          <CardTitle
                            className={styles.cardTitle}
                            aria-level={2}
                          >
                            {state.mode === "translate"
                              ? translated
                                ? copy("Translated audio", "翻译音频")
                                : copy("Source audio", "源音频")
                              : copy("Voice preview", "声音预览")}
                          </CardTitle>
                          <CardDescription className={styles.description}>
                            {state.mode === "translate"
                              ? translated
                                ? copy("English translation", "英语译文")
                                : copy("Spanish sample", "西班牙语样例")
                              : `${audioSamples[state.sample].label[locale]} · ${locale === "en" ? state.voice : state.voice === "clear" ? "清晰" : "温暖"} ${copy("voice", "声音")}`}
                          </CardDescription>
                        </div>
                        <Badge aria-live="polite" className={styles.status}>
                          {status}
                        </Badge>
                      </CardHeader>
                      <CardContent className={styles.cardContent}>
                        <div
                          className={styles.waveform}
                          role="img"
                          aria-label={copy(
                            "Waveform of the selected prerecorded audio",
                            "选中预录音频的波形",
                          )}
                          data-audio-waveform
                        >
                          {asset.peaks.map((peak, index) => (
                            <span
                              key={index}
                              className={styles.waveBar}
                              data-played={
                                index / asset.peaks.length <=
                                  position / duration || undefined
                              }
                              style={{
                                height: `${Math.max(4, (peak / peakMaximum) * 88)}px`,
                              }}
                            />
                          ))}
                        </div>
                        <div className={styles.seek}>
                          <span>{audioClock(position)}</span>
                          <Slider
                            className={styles.slider}
                            label={copy("Seek audio", "定位音频")}
                            value={position}
                            min={0}
                            max={duration}
                            step={0.01}
                            disabled={playback === "error" || pending}
                            valueText={audioClock}
                            onChange={(value) => {
                              if (player.current)
                                player.current.currentTime = value
                              setPosition(value)
                            }}
                          />
                          <span>{audioClock(duration)}</span>
                        </div>
                        <div className={styles.playActions}>
                          <div className={styles.buttonGroup}>
                            <Button
                              onClick={start}
                              disabled={
                                readonly ||
                                busy ||
                                unavailable ||
                                playback === "playing" ||
                                playback === "error"
                              }
                              className={styles.primary}
                            >
                              {state.mode === "speech" ? (
                                <Headphones size={16} />
                              ) : (
                                <Mic size={16} />
                              )}
                              {mainAction}
                            </Button>
                            <Button
                              variant="outline"
                              size="icon"
                              aria-label={
                                playback === "playing"
                                  ? copy("Pause audio", "暂停音频")
                                  : copy("Play audio", "播放音频")
                              }
                              disabled={
                                pending || unavailable || playback === "error"
                              }
                              onClick={() => {
                                if (playback === "playing")
                                  player.current?.pause()
                                else void play()
                              }}
                            >
                              {playback === "playing" ? (
                                <Pause size={16} />
                              ) : (
                                <Play size={16} />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={copy("Stop audio", "停止音频")}
                              onClick={stop}
                            >
                              <Square size={16} />
                            </Button>
                          </div>
                          <a className={styles.wavLink} href={url} download>
                            <Download size={14} />
                            WAV
                          </a>
                        </div>
                        {(playback === "error" || playback === "blocked") && (
                          <p role="alert" className={styles.error}>
                            {playback === "blocked"
                              ? copy(
                                  "Audio playback was blocked. Press Retry audio, then Play.",
                                  "音频播放受阻。请重试音频后点击播放。",
                                )
                              : copy(
                                  "The audio recording could not be loaded. Your settings and transcript are preserved.",
                                  "无法加载音频素材，保留您的设置与转录。",
                                )}{" "}
                            <Button
                              variant="outline"
                              onClick={() => {
                                setState((before) => ({
                                  ...before,
                                  failure: "none",
                                }))
                                player.current?.load()
                                setPlayback("loading")
                              }}
                            >
                              {copy("Retry audio", "重试音频")}
                            </Button>
                          </p>
                        )}
                      </CardContent>
                    </Card>
                    <Tabs
                      value={state.inspector}
                      onValueChange={(value) =>
                        setState((before) => ({
                          ...before,
                          inspector: value as AudioState["inspector"],
                        }))
                      }
                    >
                      <div className={styles.inspectorHeader}>
                        <TabsList
                          className={styles.tabsList}
                          aria-label={copy("Audio inspector", "音频检查器")}
                        >
                          <TabsTab value="transcript" className={styles.tab}>
                            {copy("Transcript", "转录")}
                          </TabsTab>
                          <TabsTab value="events" className={styles.tab}>
                            {copy("Events", "事件")}
                            {state.events.length
                              ? ` (${state.events.length})`
                              : ""}
                          </TabsTab>
                        </TabsList>
                        <span className={styles.disclaimer}>
                          {copy(
                            "Prerecorded demo · microphone not used",
                            "预录演示 · 不使用麦克风",
                          )}
                        </span>
                      </div>
                      <TabsPanel
                        value={state.inspector}
                        className={styles.inspectorPanel}
                      >
                        <div
                          ref={inspectorBody}
                          className={styles.inspectorBody}
                          data-audio-region="inspector"
                          onScroll={(event) =>
                            cache?.set(
                              `audio-inspector:${state.inspector}`,
                              event.currentTarget.scrollTop,
                            )
                          }
                        >
                          {state.inspector === "transcript" ? (
                            sessionTranscript(actualSession).length ? (
                              sessionTranscript(actualSession).map(
                                (line, index) => (
                                  <div
                                    className={styles.transcriptRow}
                                    key={index}
                                  >
                                    <span>
                                      {copy(
                                        line.speaker,
                                        line.speaker === "User"
                                          ? "用户"
                                          : line.speaker === "Assistant"
                                            ? "助手"
                                            : line.speaker ===
                                                "Spanish · source"
                                              ? "西班牙语 · 原文"
                                              : "英语 · 译文",
                                      )}
                                    </span>
                                    <p>{line.text}</p>
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      aria-label={copy(
                                        `Seek to ${line.speaker} transcript`,
                                        `定位${index + 1}段转录`,
                                      )}
                                      onClick={() => {
                                        stop()
                                        setSourcePreview(line.source)
                                        if (player.current)
                                          player.current.currentTime = line.at
                                      }}
                                    >
                                      {<Play size={14} />}
                                    </Button>
                                  </div>
                                ),
                              )
                            ) : (
                              <p className={styles.empty}>
                                {copy(
                                  "Start a sample to inspect its transcript.",
                                  "开始样例以查看其转录。",
                                )}
                              </p>
                            )
                          ) : state.events.length ? (
                            state.events.map((event, index) => (
                              <div className={styles.eventRow} key={index}>
                                <time>{event.at.toFixed(2)}s</time>
                                <div>
                                  <p>{event.name}</p>
                                  <p className={styles.eventDetail}>
                                    {event.detail}
                                  </p>
                                </div>
                              </div>
                            ))
                          ) : (
                            <p className={styles.empty}>
                              {copy("No session events yet.", "暂无会话事件。")}
                            </p>
                          )}
                        </div>
                      </TabsPanel>
                    </Tabs>
                    {(unknown || state.operation?.result === "rejected") && (
                      <p role="alert" className={styles.notice}>
                        {unknown
                          ? copy(
                              "Result unknown. Original request retained; no automatic replay.",
                              "结果未知，原始请求已保留，不自动重放。",
                            )
                          : copy(
                              "Sample request rejected. Drafts are preserved.",
                              "样例请求被拒绝，保留草稿。",
                            )}{" "}
                        <code>{state.operation?.operationId}</code>
                        {unknown && (
                          <Button
                            variant="outline"
                            onClick={() =>
                              state.operation &&
                              setState((before) =>
                                resolveAudioSession(
                                  before,
                                  state.operation!.operationId,
                                  "confirmed",
                                ),
                              )
                            }
                          >
                            {copy("Check result", "查询结果")}
                          </Button>
                        )}
                      </p>
                    )}
                  </div>
                </div>
              }
            </DataRegion>
          </TabsPanel>
        </Tabs>
        {!state.loaded && (
          <Button
            variant="outline"
            onClick={() => setState((before) => ({ ...before, loaded: true }))}
          >
            {copy("Load samples", "加载样例")}
          </Button>
        )}
        {exported && (
          <p role="status" className={styles.notice}>
            {copy(
              "Fixture request exported. No provider request was sent.",
              "已导出样例请求，未发送模型请求。",
            )}
          </p>
        )}
        <details className={styles.fixtureControls}>
          <summary>
            {copy("Fixture controls & request", "样例控制与请求")}
          </summary>
          <p>
            {copy(
              "Fixed local audio and transcripts only. WebRTC/WebSocket are request parameters, not live connections.",
              "仅固定本地音频与转录；WebRTC/WebSocket 只是请求参数，不建立实时连接。",
            )}
          </p>
          <p>{audioAssetLicense}</p>
          <a
            href={`${audioAssetBase}/LICENSE.txt`}
            target="_blank"
            rel="noreferrer"
          >
            {copy("Audio license", "音频许可")}
          </a>
          <p>
            {copy("Fixture snapshot", "样例快照")}: {apAsOf} · UTC
          </p>
          <div className={styles.fixtureSelectors}>
            <ApSelect
              label={copy("Audio failure fixture", "音频失败样例")}
              value={state.failure}
              onChange={(value) => {
                stop()
                setState((before) => ({
                  ...before,
                  failure: value as AudioFailure,
                }))
              }}
              options={[
                { value: "none", label: copy("Normal audio", "正常音频") },
                {
                  value: "asset-error",
                  label: copy("Asset loading failure", "素材加载失败"),
                },
                {
                  value: "blocked",
                  label: copy("Playback blocked", "播放受阻"),
                },
              ]}
            />
            <ApSelect
              label={copy("Sample result fixture", "样例结果")}
              value={state.outcome}
              onChange={(value) =>
                setState((before) => ({
                  ...before,
                  outcome: value as AudioOutcome,
                }))
              }
              options={[
                { value: "confirmed", label: copy("Confirmed", "确认") },
                { value: "rejected", label: copy("Rejected", "拒绝") },
                { value: "unknown", label: copy("Unknown", "未知") },
              ]}
              disabled={busy || readonly}
            />
          </div>
          <CodePreview
            identity={`audio-request:${scenario}`}
            code={JSON.stringify(
              { request, operation: state.operation },
              null,
              2,
            )}
            language="plain"
            ariaLabel={copy("Audio fixture request JSON", "音频样例请求 JSON")}
          />
        </details>
      </div>
    </ApPage>
  )
}
