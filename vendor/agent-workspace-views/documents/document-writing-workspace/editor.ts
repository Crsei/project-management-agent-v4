import type { DocumentSnapshot, Passage } from "./controller"

/** Page-local adapter for native rich-text editing; HTML never accepts external markup. */
export function editorSnapshot(editor: HTMLElement): DocumentSnapshot {
  return { html: editor.innerHTML, text: editor.textContent ?? "" }
}
export function editorPassage(editor: HTMLElement): Passage | null {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (
    !editor.contains(range.startContainer) ||
    !editor.contains(range.endContainer)
  )
    return null
  const before = range.cloneRange()
  before.selectNodeContents(editor)
  before.setEnd(range.startContainer, range.startOffset)
  const from = before.toString().length
  return { from, to: from + range.toString().length, text: range.toString() }
}
export function passageRange(
  editor: HTMLElement,
  passage: Passage,
): Range | null {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  let offset = 0
  let start: [Node, number] | null = null
  let end: [Node, number] | null = null
  while (node) {
    const length = node.textContent?.length ?? 0
    if (!start && passage.from >= offset && passage.from <= offset + length)
      start = [node, passage.from - offset]
    if (passage.to >= offset && passage.to <= offset + length) {
      end = [node, passage.to - offset]
      break
    }
    offset += length
    node = walker.nextNode()
  }
  if (!start || !end) return null
  const range = document.createRange()
  range.setStart(...start)
  range.setEnd(...end)
  return range
}
export function restorePassage(editor: HTMLElement, passage: Passage): boolean {
  const range = passageRange(editor, passage)
  if (!range) return false
  editor.focus({ preventScroll: true })
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  return true
}
export function replacePassage(
  editor: HTMLElement,
  passage: Passage,
  replacement: string,
): DocumentSnapshot | null {
  const range = passageRange(editor, passage)
  if (!range || range.toString() !== passage.text) return null
  range.deleteContents()
  range.insertNode(document.createTextNode(replacement))
  editor.normalize()
  return editorSnapshot(editor)
}
export function plainTextExport(editor: HTMLElement): string {
  return editor.innerText
}
