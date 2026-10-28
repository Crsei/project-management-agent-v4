import type {
  CanvasDocument,
  CanvasNodeDefinition,
  CanvasNodeRecord,
} from "@easyuse-ui/ui/lib/canvas-model"
import type { Copy } from "../../model"

export type MediaKind =
  "source" | "transcript" | "titles" | "thumbnail" | "description" | "publish"
export const kindLabels: Record<MediaKind, Copy> = {
  source: { "zh-CN": "来源", en: "Source" },
  transcript: { "zh-CN": "转录", en: "Transcript" },
  titles: { "zh-CN": "标题", en: "Titles" },
  thumbnail: { "zh-CN": "缩略图", en: "Thumbnail" },
  description: { "zh-CN": "描述", en: "Description" },
  publish: { "zh-CN": "YouTube 预览", en: "YouTube preview" },
}
export const objectLabels: Record<string, Copy> = {
  source: { "zh-CN": "播客设置.mp4", en: "Podcast setup.mp4" },
  transcript: { "zh-CN": "转录", en: "Transcript" },
  titles: { "zh-CN": "标题创意", en: "Title ideas" },
  "thumb-1": { "zh-CN": "缩略图 / 01", en: "Thumbnail / 01" },
  "thumb-2": { "zh-CN": "缩略图 / 02", en: "Thumbnail / 02" },
  description: { "zh-CN": "描述与章节", en: "Description & chapters" },
  publish: { "zh-CN": "YouTube 预览", en: "YouTube preview" },
}
export const transcript: Copy = {
  en: "00:00  You don't need a studio to start a podcast. Today we'll set up a recording space using the equipment you already have.\n\n00:42  Start with the room. Curtains, a rug, and a shelf of books reduce the echo before you buy another microphone.\n\n02:18  Keep the microphone a hand's width from your mouth. Speak slightly across it, rather than directly into it, to soften plosives.\n\n04:06  Record a thirty-second test. Listen for fans, keyboard noise, and clipping. Turn the input gain down before the loudest moment.\n\n06:35  Build a repeatable setup. Mark the mic position, save your recording settings, and keep a short checklist beside the desk.\n\n08:02  Your first episode doesn't need to be perfect. A clear idea, a comfortable guest, and understandable audio are enough to begin.",
  "zh-CN":
    "00:00  开始录制播客不需要专业录音棚。今天我们用已有设备搭建录音空间。\n\n00:42  从房间开始。窗帘、地毯和书架能减少回声，不必急着购买新麦克风。\n\n02:18  麦克风与嘴保持一掌距离。稍微侧着说话，避免直接吹向麦克风以减少爆破音。\n\n04:06  录制三十秒测试。听听风扇、键盘和失真声。在最响的时刻到来之前降低输入增益。\n\n06:35  建立可重复的设置。标记麦克风位置，保存录音设置，把简短的检查清单放在桌旁。\n\n08:02  第一期播客无需完美。清晰的想法、放松的嘉宾和听得清的声音就足够开始。",
}
export const description: Copy = {
  en: "Start recording with the equipment you already have. In this episode: room treatment, microphone placement, gain, and a repeatable recording checklist.\n\n00:00 Start with what you have\n00:42 Treat the room\n02:18 Place the microphone\n04:06 Record a test\n06:35 Save your setup",
  "zh-CN":
    "用已有设备开始录音。本期内容：房间声学处理、麦克风位置、增益设置以及可重复的录音检查清单。\n\n00:00 从已有设备开始\n00:42 处理房间回声\n02:18 放置麦克风\n04:06 录制测试\n06:35 保存你的设置",
}
export const titleIdeas: Copy[] = [
  {
    en: "Record your first podcast—with the gear you have",
    "zh-CN": "用已有设备录制你的第一期播客",
  },
  {
    en: "3 fixes that make a budget mic sound better",
    "zh-CN": "让入门麦克风听起来更好的 3 个技巧",
  },
  {
    en: "Your room matters more than your microphone",
    "zh-CN": "房间比麦克风更重要",
  },
]
export const headlines: Copy[] = [
  { en: "START YOUR\nPODCAST", "zh-CN": "开始你的\n播客" },
  { en: "BETTER AUDIO\nFOR $0", "zh-CN": "零成本\n改善音质" },
]
export const mediaSizes: Record<MediaKind, { width: number; height: number }> =
  {
    source: { width: 330, height: 380 },
    transcript: { width: 360, height: 590 },
    titles: { width: 380, height: 245 },
    thumbnail: { width: 340, height: 260 },
    description: { width: 380, height: 310 },
    publish: { width: 340, height: 280 },
  }
function createDefinitions(locale: keyof Copy): CanvasNodeDefinition[] {
  return (Object.keys(kindLabels) as MediaKind[]).map((type) => ({
    type,
    label: kindLabels[type][locale],
    category: locale === "en" ? "Media pipeline" : "媒体流水线",
    defaults: {},
    ports: [
      ...(type === "source"
        ? []
        : [
            {
              id: "in",
              label: "",
              direction: "input" as const,
              type: "object" as const,
            },
          ]),
      ...(type === "publish"
        ? []
        : [
            {
              id: "out",
              label: "",
              direction: "output" as const,
              type: "object" as const,
            },
          ]),
    ],
  }))
}
export const definitionsByLocale = {
  "zh-CN": createDefinitions("zh-CN"),
  en: createDefinitions("en"),
} satisfies Record<keyof Copy, CanvasNodeDefinition[]>
export function createPipeline(scenario: string): CanvasDocument {
  const nodes: CanvasNodeRecord[] = [
    {
      id: "source",
      type: "source",
      title: objectLabels.source.en,
      position: { x: 0, y: 220 },
      config: { url: "", image: "" },
    },
    {
      id: "transcript",
      type: "transcript",
      title: objectLabels.transcript.en,
      position: { x: 425, y: 105 },
      config: {},
    },
    {
      id: "titles",
      type: "titles",
      title: objectLabels.titles.en,
      position: { x: 890, y: 0 },
      config: {},
    },
    {
      id: "thumb-1",
      type: "thumbnail",
      title: objectLabels["thumb-1"].en,
      position: { x: 890, y: 345 },
      config: { color: "amber" },
    },
    {
      id: "thumb-2",
      type: "thumbnail",
      title: objectLabels["thumb-2"].en,
      position: { x: 1300, y: 345 },
      config: { color: "mint" },
    },
    {
      id: "description",
      type: "description",
      title: objectLabels.description.en,
      position: { x: 890, y: 715 },
      config: {},
    },
    {
      id: "publish",
      type: "publish",
      title: objectLabels.publish.en,
      position: { x: 1300, y: 0 },
      config: {},
    },
  ]
  return {
    schemaVersion: 1,
    id: "youtube-content-pipeline",
    revision: 0,
    nodes: scenario === "empty" || scenario === "loading" ? [] : nodes,
    frames: [],
    notes: [],
    edges:
      scenario === "empty" || scenario === "loading"
        ? []
        : [
            ["source", "transcript"],
            ["transcript", "titles"],
            ["transcript", "thumb-1"],
            ["transcript", "thumb-2"],
            ["transcript", "description"],
            ["titles", "publish"],
            ["thumb-1", "publish"],
          ].map(([source, target]) => ({
            id: `${source}-${target}`,
            source,
            target,
            sourcePort: "out",
            targetPort: "in",
          })),
  }
}
