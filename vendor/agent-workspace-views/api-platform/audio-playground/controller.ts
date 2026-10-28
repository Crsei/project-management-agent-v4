import { apScope, type ApOperationResult, type ApScenario } from "../model.ts"
import {
  audioAssetBase,
  audioAssets,
  audioFixtureRevision,
  audioSamples,
  defaultInstructions,
  translationSource,
  translationText,
  type AudioMode,
  type AudioSampleId,
  type AudioVoice,
} from "./fixtures.ts"

export type AudioFailure = "none" | "asset-error" | "blocked"
export type AudioOutcome = "confirmed" | "rejected" | "unknown"
export type AudioRequest = {
  source: "fixture"
  fixtureRevision: string
  scope: typeof apScope
  mode: AudioMode
  sample: AudioSampleId
  voice: AudioVoice
  speed: number
  instructions?: string
  input?: string
  transport?: "webrtc" | "websocket"
  noiseReduction?: "near_field" | "far_field" | "off"
  turnDetection?: boolean
  sourceLanguage?: "es"
  targetLanguage?: "en"
  outputFormat: "wav"
}
export type AudioOperation = {
  operationId: string
  payload: AudioRequest
  result: ApOperationResult
}
export type AudioSession = {
  mode: AudioMode
  sample: AudioSampleId
  voice: AudioVoice
  translated: boolean
}
export type AudioEvent = { at: number; name: string; detail: string }
export type AudioState = {
  mode: AudioMode
  sample: AudioSampleId
  voice: AudioVoice
  speed: string
  instructions: string
  scripts: Record<AudioSampleId, string>
  transport: "webrtc" | "websocket"
  noiseReduction: "near_field" | "far_field" | "off"
  turnDetection: boolean
  inspector: "transcript" | "events"
  session: AudioSession | null
  operation: AudioOperation | null
  outcome: AudioOutcome
  failure: AudioFailure
  events: AudioEvent[]
  loaded: boolean
  refreshed: boolean
  sequence: number
  caret: Record<string, { start: number; end: number }>
}
export function createAudioState(scenario: ApScenario): AudioState {
  return {
    mode: "live",
    sample: "welcome",
    voice: "clear",
    speed: "1",
    instructions: defaultInstructions,
    scripts: {
      welcome:
        scenario === "long-content"
          ? audioSamples.welcome.script.repeat(20)
          : audioSamples.welcome.script,
      delivery: audioSamples.delivery.script,
    },
    transport: "webrtc",
    noiseReduction: "near_field",
    turnDetection: true,
    inspector: "transcript",
    session: null,
    operation: null,
    outcome: "confirmed",
    failure: scenario === "missing-data" ? "asset-error" : "none",
    events: [],
    loaded: scenario !== "loading",
    refreshed: false,
    sequence: 0,
    caret: {},
  }
}
export function audioRequest(
  state: AudioState,
  scenario: ApScenario,
): AudioRequest {
  const request: AudioRequest = {
    source: "fixture",
    fixtureRevision: audioFixtureRevision,
    scope: { ...apScope, canWrite: scenario !== "readonly" },
    mode: state.mode,
    sample: state.sample,
    voice: state.voice,
    speed: Number(state.speed),
    outputFormat: "wav",
  }
  if (state.mode === "speech") request.input = state.scripts[state.sample]
  else if (state.mode === "translate") {
    request.sourceLanguage = "es"
    request.targetLanguage = "en"
    request.input = translationSource
  } else request.instructions = state.instructions
  if (state.mode === "realtime") {
    request.transport = state.transport
    request.noiseReduction = state.noiseReduction
    request.turnDetection = state.turnDetection
  }
  return request
}
export function selectedAudioAsset(state: AudioState, translated = false) {
  const id =
    state.mode === "translate"
      ? `${translated ? "translation" : "spanish"}-clear`
      : `${state.sample}-${state.voice}`
  return audioAssets[id]
}
export function audioAssetUrl(state: AudioState, translated = false) {
  return `${audioAssetBase}/${selectedAudioAsset(state, translated).file}`
}
export function beginAudioSession(
  state: AudioState,
  scenario: ApScenario,
): AudioState {
  if (
    scenario === "readonly" ||
    scenario === "empty" ||
    !state.loaded ||
    state.operation?.result === "pending" ||
    state.operation?.result === "unknown"
  )
    return state
  const sequence = state.sequence + 1
  return {
    ...state,
    sequence,
    session: null,
    operation: {
      operationId: `audio-fixture-${sequence}`,
      payload: audioRequest(state, scenario),
      result: "pending",
    },
    events: [
      { at: 0, name: "session.created", detail: "Prerecorded sample session" },
    ],
  }
}
export function resolveAudioSession(
  state: AudioState,
  operationId: string,
  result: AudioOutcome,
): AudioState {
  if (
    state.operation?.operationId !== operationId ||
    !["pending", "unknown"].includes(state.operation.result)
  )
    return state
  const payload = state.operation.payload
  const confirmed = result === "confirmed"
  return {
    ...state,
    operation: { ...state.operation, result },
    session: confirmed
      ? {
          mode: payload.mode,
          sample: payload.sample,
          voice: payload.voice,
          translated: payload.mode === "translate",
        }
      : state.session,
    events: confirmed
      ? [
          ...state.events,
          ...(payload.mode === "live" || payload.mode === "realtime"
            ? [
                {
                  at: 0.28,
                  name: "input.transcript.completed",
                  detail: audioSamples[payload.sample].user,
                },
              ]
            : []),
          {
            at: 0.65,
            name:
              payload.mode === "translate"
                ? "translation.completed"
                : "response.audio.started",
            detail:
              payload.mode === "translate"
                ? "English translation · prerecorded sample"
                : `${payload.voice} voice · prerecorded reply`,
          },
        ]
      : [
          ...state.events,
          {
            at: 0.65,
            name: `session.${result}`,
            detail:
              result === "unknown"
                ? "Result unknown. Check the original operation; do not replay."
                : "Fixture request rejected; draft preserved",
          },
        ],
  }
}
export function cancelAudioSession(state: AudioState): AudioState {
  if (state.operation?.result !== "pending") return state
  return {
    ...state,
    operation: { ...state.operation, result: "rejected" },
    events: [
      ...state.events,
      {
        at: 0,
        name: "session.cancelled",
        detail: "Local processing cancelled before confirmation",
      },
    ],
  }
}

export function audioSessionMatchesSelection(state: AudioState): boolean {
  return (
    state.session !== null &&
    state.session.mode === state.mode &&
    state.session.sample === state.sample &&
    state.session.voice === state.voice
  )
}

export function sessionTranscript(session: AudioSession | null) {
  if (!session) return []
  if (session.mode === "translate")
    return [
      {
        speaker: "Spanish · source",
        text: translationSource,
        at: 0,
        source: true,
      },
      {
        speaker: "English · translation",
        text: translationText,
        at: 0,
        source: false,
      },
    ]
  return session.mode === "speech"
    ? [
        {
          speaker: "Assistant",
          text: audioSamples[session.sample].script,
          at: 0,
          source: false,
        },
      ]
    : [
        {
          speaker: "User",
          text: audioSamples[session.sample].user,
          at: 0,
          source: false,
        },
        {
          speaker: "Assistant",
          text: audioSamples[session.sample].script,
          at: 0,
          source: false,
        },
      ]
}
export function audioClock(seconds: number) {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}
