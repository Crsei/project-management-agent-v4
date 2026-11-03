import { useEffect, useId, useRef } from "react"
import { EditorContent, useEditor, useEditorState } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { Markdown } from "@tiptap/markdown"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n-provider"
import { useWorkspaceStore } from "@/providers/app-providers"

type Props = { value: string; onChange: (value: string) => void; disabled?: boolean; label?: string }

export function RichTextEditor({ value, onChange, disabled = false, label }: Props) {
  const { locale } = useI18n()
  const spellcheck = useWorkspaceStore(state => state.spellcheck)
  const en = locale === "en"
  const id = useId()
  const name = label ?? (en ? "Description" : "描述")
  const change = useRef(onChange)
  change.current = onChange
  const lastEmitted = useRef(value)
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false, autolink: false }, underline: false, code: { HTMLAttributes: { spellcheck: "false" } }, codeBlock: { HTMLAttributes: { spellcheck: "false" } } }), Markdown],
    content: value,
    contentType: "markdown",
    editable: !disabled,
    immediatelyRender: false,
    editorProps: {
      attributes: { role: "textbox", "aria-multiline": "true", "aria-label": name, "aria-describedby": `${id}-help`, class: "min-h-40 p-3 outline-none [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_pre]:overflow-auto [&_pre]:rounded-control [&_pre]:bg-muted [&_pre]:p-3 [&_a]:text-primary [&_a:hover]:text-foreground" },
    },
    onUpdate: ({ editor: current }) => {
      const markdown = current.getMarkdown()
      lastEmitted.current = markdown
      change.current(markdown)
    },
  })
  const state = useEditorState({ editor, selector: ({ editor: current }) => current ? {
    bold: current.isActive("bold"), italic: current.isActive("italic"), strike: current.isActive("strike"),
    heading: current.isActive("heading", { level: 2 }), bullet: current.isActive("bulletList"), ordered: current.isActive("orderedList"),
    quote: current.isActive("blockquote"), code: current.isActive("codeBlock"), undo: current.can().undo(), redo: current.can().redo(),
  } : null })
  useEffect(() => { editor?.setEditable(!disabled) }, [editor, disabled])
  useEffect(() => {
    editor?.setOptions({ editorProps: { ...editor.options.editorProps, attributes: { ...editor.options.editorProps.attributes, "aria-label": name, "aria-disabled": String(disabled), spellcheck: String(spellcheck) } } })
  }, [editor, name, disabled, spellcheck])
  useEffect(() => {
    if (!editor || value === lastEmitted.current) return
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false })
    lastEmitted.current = value
  }, [editor, value])
  const tools = [
    { text: en ? "Bold" : "粗体", active: state?.bold, run: () => editor?.chain().focus().toggleBold().run() },
    { text: en ? "Italic" : "斜体", active: state?.italic, run: () => editor?.chain().focus().toggleItalic().run() },
    { text: en ? "Strike" : "删除线", active: state?.strike, run: () => editor?.chain().focus().toggleStrike().run() },
    { text: en ? "Heading" : "标题", active: state?.heading, run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { text: en ? "Bullet list" : "无序列表", active: state?.bullet, run: () => editor?.chain().focus().toggleBulletList().run() },
    { text: en ? "Numbered list" : "有序列表", active: state?.ordered, run: () => editor?.chain().focus().toggleOrderedList().run() },
    { text: en ? "Quote" : "引用", active: state?.quote, run: () => editor?.chain().focus().toggleBlockquote().run() },
    { text: en ? "Code block" : "代码块", active: state?.code, run: () => editor?.chain().focus().toggleCodeBlock().run() },
  ]
  return <div className="space-y-2">
    <span className="text-sm font-medium">{name}</span>
    <div className="rounded-panel border border-border bg-background focus-within:ring-2 focus-within:ring-ring">
      <div role="group" aria-label={en ? "Text formatting" : "文本格式"} className="flex flex-wrap gap-1 border-b border-border p-2">
        {tools.map(tool => <Button key={tool.text} variant="ghost" size="sm" disabled={disabled || !editor} aria-pressed={Boolean(tool.active)} onClick={tool.run}>{tool.text}</Button>)}
        <Button variant="ghost" size="sm" disabled={disabled || !state?.undo} onClick={() => editor?.chain().focus().undo().run()}>{en ? "Undo" : "撤销"}</Button>
        <Button variant="ghost" size="sm" disabled={disabled || !state?.redo} onClick={() => editor?.chain().focus().redo().run()}>{en ? "Redo" : "重做"}</Button>
      </div>
      <EditorContent editor={editor} />
    </div>
    <p id={`${id}-help`} className="text-xs text-muted-foreground">{en ? "Stored as Markdown text, including paragraphs and lists. Ctrl/Cmd+B for bold; Ctrl/Cmd+I for italic. Saving is controlled by the enclosing form." : "以 Markdown 文本保存，保留段落与列表。Ctrl/Cmd+B 加粗，Ctrl/Cmd+I 斜体。由外部表单提交保存。"}</p>
  </div>
}
