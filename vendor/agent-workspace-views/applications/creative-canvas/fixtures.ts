import type { CanvasDocument, CanvasNodeDefinition } from "@easyuse-ui/ui/lib/canvas-model"

export type Copy = { "zh-CN": string; en: string }
export const titles: Record<string, Copy> = {
  source: { "zh-CN": "播客 / 源画面", en: "Podcast / source frame" },
  "prompt-1": { "zh-CN": "01 / 缓慢推近", en: "01 / Slow push in" },
  "clip-1": { "zh-CN": "01 / 推近", en: "01 / Push in" },
  "prompt-2": { "zh-CN": "02 / 向左平移", en: "02 / Slide left" },
  "clip-2": { "zh-CN": "02 / 向左平移", en: "02 / Slide left" },
  "prompt-3": { "zh-CN": "03 / 拉远", en: "03 / Pull back" },
  "clip-3": { "zh-CN": "03 / 拉远", en: "03 / Pull back" },
  refine: { "zh-CN": "优化 / 更近的取景", en: "Refine / closer framing" },
  final: { "zh-CN": "04 / 优化样片", en: "04 / Refined take" },
}
export const prompts: Record<string, Copy> = {
  "prompt-1": { "zh-CN": "保持讲者与录音室不变。从中景人像开始，缓慢向麦克风推近。连续镜头，无剪切。", en: "Keep the speaker and studio unchanged. Start at a medium portrait crop and move slowly toward the microphone. One continuous shot, no cuts." },
  "prompt-2": { "zh-CN": "保留讲者、麦克风和温暖的录音室灯光。镜头缓慢向左平移，始终保持面部在画面中。", en: "Preserve the speaker, microphone, and warm studio lighting. Move the camera gently to the left. Keep the face in frame throughout." },
  "prompt-3": { "zh-CN": "从紧凑特写开始，缓慢展示更多录音设备。保留表情与麦克风位置，不切换场景。", en: "Begin with a tight close-up and slowly reveal more of the recording setup. Preserve the expression and microphone position. No scene changes." },
  refine: { "zh-CN": "以第二个结果作为参考。缩紧画面，让镜头运动更细腻。保持相同的灯光与背景。", en: "Use the second result as the reference. Tighten the frame and make the movement more subtle. Keep the same lighting and background." },
}
export const movements: Record<string, Copy> = {
  push: { "zh-CN": "推近", en: "Push in" }, slide: { "zh-CN": "向左平移", en: "Slide left" }, pull: { "zh-CN": "拉远", en: "Pull back" },
}
const input = { id: "in", label: "Input", direction: "input" as const, type: "object" as const }
const output = { id: "out", label: "Output", direction: "output" as const, type: "object" as const }
export const definitions: CanvasNodeDefinition[] = [
  { type: "source", label: "Source", category: "Media", ports: [output], defaults: {} },
  { type: "prompt", label: "Prompt", category: "Media", ports: [input, output], defaults: { text: "", movement: "push", duration: 6 } },
  { type: "clip", label: "Motion preview", category: "Media", ports: [input, output], defaults: { movement: "push", duration: 6 } },
]
export const nodeDimensions = (type: string) => type === "source" ? { width: 275, height: 410 } : type === "prompt" ? { width: 310, height: 230 } : { width: 225, height: 315 }
export function canvasFixture(scenario: string): CanvasDocument {
  const nodes: CanvasDocument["nodes"] = [{ id: "source", type: "source", title: titles.source.en, position: { x: 0, y: 295 }, config: { image: "studio" } }]
  const edges: CanvasDocument["edges"] = []
  for (let i = 1; i <= 3; i++) {
    const movement = ["push", "slide", "pull"][i - 1]
    nodes.push({ id: "prompt-" + i, type: "prompt", title: titles["prompt-" + i].en, position: { x: 415, y: (i - 1) * 385 }, config: { text: prompts["prompt-" + i].en, movement, duration: 6 } }, { id: "clip-" + i, type: "clip", title: titles["clip-" + i].en, position: { x: 865, y: (i - 1) * 385 }, config: { movement, duration: 6 } })
    for (const [source, target] of [["source", "prompt-" + i], ["prompt-" + i, "clip-" + i], ["source", "clip-" + i]]) edges.push({ id: source + "-" + target, source, target, sourcePort: "out", targetPort: "in" })
  }
  nodes.push({ id: "refine", type: "prompt", title: titles.refine.en, position: { x: 1210, y: 385 }, config: { text: prompts.refine.en, movement: "push", duration: 6 } }, { id: "final", type: "clip", title: titles.final.en, position: { x: 1660, y: 385 }, config: { movement: "push", duration: 6 } })
  edges.push({ id: "clip-2-refine", source: "clip-2", target: "refine", sourcePort: "out", targetPort: "in" }, { id: "refine-final", source: "refine", target: "final", sourcePort: "out", targetPort: "in" })
  if (scenario === "long-content") nodes.find(n => n.id === "prompt-1")!.config.text = prompts["prompt-1"].en + " " + Array.from({ length: 12 }, (_, i) => "Direction " + (i + 1) + ": keep the speaker centered, retain natural facial expression and avoid sudden framing changes.").join(" ")
  return { schemaVersion: 1, id: "creative-canvas", revision: 0, nodes: scenario === "empty" ? [] : nodes, edges: scenario === "empty" ? [] : edges, frames: [], notes: [] }
}
// Original task-authored illustration. No third-party portrait or sample media is redistributed.
export const studioImage = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 720"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#34261e"/><stop offset="1" stop-color="#171619"/></linearGradient><radialGradient id="glow"><stop stop-color="#d6a36c" stop-opacity=".38"/><stop offset="1" stop-color="#d6a36c" stop-opacity="0"/></radialGradient></defs><rect width="540" height="720" fill="url(#bg)"/><g stroke="#6a4832" stroke-width="11" opacity=".7"><path d="M30 0v720M80 0v720M130 0v720M430 0v720M480 0v720M530 0v720"/></g><ellipse cx="310" cy="230" rx="270" ry="280" fill="url(#glow)"/><path d="M99 720c8-140 45-253 178-261 140-9 190 93 208 261" fill="#23242b"/><path d="M166 320c-28-102-7-210 78-224 118-28 178 69 166 165l-11 203-73 47-137-67z" fill="#282020"/><ellipse cx="287" cy="272" rx="82" ry="116" fill="#d5a183"/><path d="M197 254c-32-67 7-144 79-146 55-6 101 46 112 95-55-14-69-31-83-56-11 43-43 76-108 107" fill="#302522"/><path d="M245 280q14-10 29 0m39 0q14-10 29 0" fill="none" stroke="#50342d" stroke-width="6" stroke-linecap="round"/><path d="M291 291l-8 38 19 2m-36 32q26 21 52-2" fill="none" stroke="#8d534b" stroke-width="5" stroke-linecap="round"/><path d="M239 392l-7 67q48 43 105 0l-8-71" fill="#c18d75"/><path d="M158 447q-5 104 74 108m128-129q50 46 67 108" fill="none" stroke="#282020" stroke-width="34" stroke-linecap="round"/><g transform="translate(365 363) rotate(-17)"><rect x="-33" y="0" width="66" height="145" rx="32" fill="#45454b"/><g stroke="#24242b" stroke-width="5"><path d="M-24 23h48M-27 39h54M-27 55h54M-27 71h54M-27 87h54"/></g><rect x="-7" y="135" width="14" height="81" fill="#69686d"/><path d="M0 198l100 94" fill="none" stroke="#36363d" stroke-width="18"/></g><path d="M0 648q120-18 540 5v67H0z" fill="#19181c"/></svg>`)
