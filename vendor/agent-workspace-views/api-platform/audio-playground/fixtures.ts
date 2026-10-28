import type { ApCopy } from "../model"

export type AudioMode = "live" | "realtime" | "translate" | "speech"
export type AudioSampleId = "welcome" | "delivery"
export type AudioVoice = "clear" | "warm"
export const audioFixtureRevision = "audio-playground-v1-2026-10-13"
export const audioModes: { value: AudioMode; label: ApCopy }[] = [
  { value: "live", label: { en: "Live voice", "zh-CN": "实时语音" } },
  { value: "realtime", label: { en: "Realtime", "zh-CN": "实时会话" } },
  { value: "translate", label: { en: "Translate", "zh-CN": "翻译" } },
  { value: "speech", label: { en: "Text to speech", "zh-CN": "文字转语音" } },
]
export const audioSamples = {
  welcome: {
    label: { en: "Workspace welcome", "zh-CN": "工作区欢迎" },
    user: "What can I do in this workspace?",
    script:
      "Your workspace is ready. I can help you review recent activity, find a document, or prepare a report. What would you like to work on?",
  },
  delivery: {
    label: { en: "Delivery update", "zh-CN": "配送更新" },
    user: "When will my order arrive?",
    script:
      "Your order is on its way. The latest update shows delivery on Friday, September eleventh. I can also send you the tracking details.",
  },
} satisfies Record<
  AudioSampleId,
  { label: ApCopy; user: string; script: string }
>
export const audioVoices = [
  {
    value: "clear",
    label: { en: "Clear · conversational", "zh-CN": "清晰 · 对话式" },
  },
  { value: "warm", label: { en: "Warm · measured", "zh-CN": "温暖 · 舒缓" } },
] as const
export const audioSpeeds = ["0.75", "1", "1.25", "1.5"] as const
export const defaultInstructions =
  "Be a concise, helpful assistant. Confirm the user's intent before suggesting the next step."
export const translationSource =
  "Hola, me gustaría saber cuándo llega mi pedido."
export const translationText =
  "Hello, I would like to know when my order arrives."
export const audioAssetBase = "/fixtures/api-platform/audio-playground"
export const audioAssetLicense =
  "CC0-1.0 · original synthetic speech fixtures; generated offline with eSpeak 1.48.04. No reference audio is redistributed."
export type AudioAsset = {
  id: string
  file: string
  duration: number
  peaks: number[]
}
export { audioAssets } from "./media-metadata.ts"
