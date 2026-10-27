import assert from "node:assert/strict"
import test from "node:test"
import type { Entity } from "@contracts"
import { filePreviewPolicy, literalPreviewText, matchesPreviewSignature, textPreviewLimit } from "./preview-model.ts"

const version: Entity = {
  id: "00000000-0000-4000-8000-000000000001", workspaceId: "00000000-0000-4000-8000-000000000002", projectId: "PRJ-001",
  kind: "artifact_version", version: 1, data: { fileName: "readme.txt", mediaType: "text/plain" }, createdAt: null, updatedAt: null, createdBy: "owner",
}

test("file previews require the authorized immutable version and reject active formats", () => {
  for (const [mediaType, name, expected] of [["image/png", "a.png", "image"], ["application/pdf", "a.pdf", "pdf"], ["text/plain", "a.txt", "text"], ["text/markdown", "a.md", "text"], ["text/html", "a.html", "unsupported"], ["image/svg+xml", "a.svg", "unsupported"], ["text/plain", "a.svg.txt", "unsupported"], ["application/xml", "a.xml", "unsupported"], ["application/javascript", "a.js", "unsupported"], ["application/octet-stream", "a.png", "unsupported"]]) {
    assert.equal(filePreviewPolicy({ ...version, data: { mediaType, fileName: name } }, version.workspaceId, version.id).kind, expected)
  }
  assert.throws(() => filePreviewPolicy({ ...version, kind: "upload" }, version.workspaceId, version.id), /unavailable/)
  assert.throws(() => filePreviewPolicy(version, "other", version.id), /unavailable/)
  assert.throws(() => filePreviewPolicy(version, version.workspaceId, "other"), /unavailable/)
})

test("preview media signatures do not turn forged HTML or SVG into raster images or PDFs", () => {
  const encoder = new TextEncoder()
  for (const source of ["<svg onload='alert(1)'/>", "<html><script>fetch('https://example.test')</script></html>"]) {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "application/pdf"]) assert.equal(matchesPreviewSignature(encoder.encode(source), mime), false)
  }
  assert.equal(matchesPreviewSignature(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), "image/png"), true)
  assert.equal(matchesPreviewSignature(encoder.encode("%PDF-1.7\n"), "application/pdf"), true)
  assert.equal(matchesPreviewSignature(encoder.encode("RIFF1234WEBP"), "image/webp"), true)
})

test("text previews stay bounded UTF-8 literal text, not interpreted markup", () => {
  const encoder = new TextEncoder()
  const literal = "你好\n<script>fetch('https://example.test')</script>\ttext"
  assert.equal(literalPreviewText(encoder.encode(literal)), literal)
  assert.equal(literalPreviewText(new Uint8Array(textPreviewLimit).fill(65)).length, textPreviewLimit)
  assert.throws(() => literalPreviewText(new Uint8Array(textPreviewLimit + 1)), /text_limit/)
  assert.throws(() => literalPreviewText(new Uint8Array([0xff])), /not_text/)
  assert.throws(() => literalPreviewText(new Uint8Array([0])), /not_text/)
})
