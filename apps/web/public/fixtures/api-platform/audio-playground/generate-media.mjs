import { readFile, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const directory = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(directory, "../../../../../..")
const fixturesPath = path.join(
  root,
  "vendor/agent-workspace-views/api-platform/audio-playground/fixtures.ts",
)
const fixtures = await readFile(fixturesPath, "utf8")
const scripts = [...fixtures.matchAll(/script:\s*"([^"]+)"/g)].map(
  (match) => match[1],
)
const source = fixtures.match(/translationSource\s*=\s*"([^"]+)"/)[1]
const translated = fixtures.match(/translationText\s*=\s*"([^"]+)"/)[1]
const recordings = [
  ["welcome-clear", scripts[0], "en", "185", "52"],
  ["welcome-warm", scripts[0], "en", "155", "36"],
  ["delivery-clear", scripts[1], "en", "185", "52"],
  ["delivery-warm", scripts[1], "en", "155", "36"],
  ["spanish-clear", source, "es", "185", "52"],
  ["translation-clear", translated, "en", "185", "52"],
]
const assets = {}
for (const [id, text, voice, speed, pitch] of recordings) {
  const file = `${id}.wav`
  const args = [
    "-v",
    voice,
    "-s",
    speed,
    "-p",
    pitch,
    "-w",
    path.join(directory, file),
    text,
  ]
  if (process.env.ESPEAK_DATA_PARENT)
    args.unshift(`--path=${process.env.ESPEAK_DATA_PARENT}`)
  const result = spawnSync(process.env.ESPEAK_BIN ?? "espeak", args, {
    encoding: "utf8",
  })
  if (result.status !== 0)
    throw new Error(result.stderr || `eSpeak failed: ${id}`)
  const wav = await readFile(path.join(directory, file))
  let data, rate, channels, bits
  for (let at = 12; at + 8 <= wav.length;) {
    const name = wav.toString("ascii", at, at + 4)
    const size = wav.readUInt32LE(at + 4)
    if (name === "fmt ") {
      channels = wav.readUInt16LE(at + 10)
      rate = wav.readUInt32LE(at + 12)
      bits = wav.readUInt16LE(at + 22)
    }
    if (name === "data") data = wav.subarray(at + 8, at + 8 + size)
    at += 8 + size + (size % 2)
  }
  if (!data || bits !== 16 || channels !== 1)
    throw new Error(`Expected mono PCM16: ${id}`)
  const sampleCount = data.length / 2
  const peaks = Array.from({ length: 96 }, (_, index) => {
    const from = Math.floor((index * sampleCount) / 96)
    const to = Math.floor(((index + 1) * sampleCount) / 96)
    let peak = 0
    for (let sample = from; sample < to; sample++)
      peak = Math.max(peak, Math.abs(data.readInt16LE(sample * 2)))
    return Math.round((1000 * peak) / 32768) / 1000
  })
  assets[id] = { id, file, duration: sampleCount / rate, peaks }
}
await writeFile(
  path.join(
    root,
    "packages/agent-workspace-views/api-platform/audio-playground/media-metadata.ts",
  ),
  `import type { AudioAsset } from "./fixtures"\n\nexport const audioAssets: Record<string, AudioAsset> = ${JSON.stringify(assets, null, 2)}\n`,
)
console.log(
  `Generated ${recordings.length} original CC0 PCM WAV recordings and measured waveforms.`,
)
