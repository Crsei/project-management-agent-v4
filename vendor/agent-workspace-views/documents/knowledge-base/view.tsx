"use client"

import { useLayoutEffect, useRef } from "react"
import { ArrowRight, ArrowUp, Bookmark, Bot, Check, Highlighter, Monitor, Moon, NotebookPen, Quote, Search, Sun, Trash2, X } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Item } from "@easyuse-ui/ui/components/ui/item"
import { Progress } from "@easyuse-ui/ui/components/ui/progress"
import { Tabs, TabsList, TabsTab, TabsPanel } from "@easyuse-ui/ui/components/ui/tabs"
import { Skeleton } from "@easyuse-ui/ui/components/ui/skeleton"
import { ChatComposer, ChatMessage } from "@easyuse-ui/ui/components/blocks/chat-message"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { useRemainingPageState } from "../../showcase/state"
import { addDocumentNote, answerDocumentQuestion, answerQuote, createKnowledgeState, documentCitation, filterLibrary, libraryCounts, recoverLibrary, removeDocumentNote, selectDocument, toggleDocumentStar, togglePassageHighlight, type LibraryFilter, type ReaderPanel } from "./controller"
import type { Localized } from "./fixtures"
import styles from "./knowledge-base.module.css"

export const pageScenarios = remainingPageScenarios

export function RemainingPageView({ scenario, active, host, cache }: RemainingPageProps) {
  const { locale } = useI18n()
  const label = (zh: string, en: string) => locale === "en" ? en : zh
  const copy = (value: Localized) => value[locale]
  const [state, setState] = useRemainingPageState(`knowledge-base:${scenario}`, () => createKnowledgeState(scenario))
  const reader = useRef<HTMLElement>(null)
  const library = useRef<HTMLUListElement>(null)
  const history = useRef<HTMLDivElement>(null)
  const noteInput = useRef<HTMLInputElement>(null)
  const followAnswers = useRef(true)
  const document = state.documents.find((item) => item.id === state.selectedId)
  const documents = filterLibrary(state)
  const counts = libraryCounts(state)
  const notes = state.notes.filter((note) => note.documentId === state.selectedId)
  const highlighted = Boolean(state.selectedId && state.highlighted.includes(state.selectedId))
  const starred = Boolean(state.selectedId && state.starred.includes(state.selectedId))
  const loading = state.dataState === "loading"
  const noteDraft = document ? state.noteDrafts[document.id] ?? "" : ""
  const questionDraft = document ? state.questionDrafts[document.id] ?? "" : ""
  const scrollKey = `knowledge-base:${scenario}:reading:${state.selectedId}`

  useLayoutEffect(() => {
    if (active && reader.current) reader.current.scrollTop = Number(cache.get(scrollKey) ?? 0)
    if (active && library.current) library.current.scrollTop = Number(cache.get(`knowledge-base:${scenario}:library-scroll`) ?? 0)
  }, [active, cache, scrollKey, scenario, locale, host.resolvedTheme])

  useLayoutEffect(() => {
    if (!active || !history.current) return
    if (followAnswers.current) history.current.scrollTop = history.current.scrollHeight
    else history.current.scrollTop = Number(cache.get(`knowledge-base:${scenario}:answer-scroll`) ?? 0)
  }, [active, state.answers.length, cache, scenario])

  function sendQuestion(text: string) {
    if (!document || !text.trim() || loading) return
    setState((previous) => answerDocumentQuestion(previous, text))
  }

  return (
    <section className={styles.page} data-knowledge-base data-locale={locale} aria-busy={loading || undefined} ><header className={styles.header} data-knowledge-header>
      <span>{label("知识库", "Knowledge base")}</span>
      <div>
        <span className={styles.headerSummary}>{label(`${state.documents.length} 份文档 · 公司文库`, `${state.documents.length} documents · company library`)}</span>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon" variant="ghost" aria-label={label("切换主题", "Toggle theme")} />}>
            {host.resolvedTheme === "dark" ? <Moon /> : <Monitor />}
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => host.setTheme("light")}><Sun />{label("浅色", "Light")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => host.setTheme("dark")}><Moon />{label("深色", "Dark")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => host.setTheme("system")}><Monitor />{label("跟随系统", "System")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
    {state.dataState === "refresh-error" && (
      <div className={styles.dataNotice} role="alert">
        <span>{label("文库刷新失败，已保留当前文档、标注和草稿。", "Library refresh failed. Current documents, annotations, and drafts are retained.")}</span>
        <Button variant="outline" size="sm" onClick={() => setState(recoverLibrary)}>{label("重新读取本地示例", "Reload local sample")}</Button>
      </div>
    )}
    {state.readonly && <div className={styles.dataNotice} role="status">{label("只读文库：可以阅读和提问，不能修改收藏、笔记或高亮。", "Read-only library: reading and questions are available; bookmarks, notes, and highlights cannot be changed.")}</div>}
    <div className={styles.columns}>
      <section className={styles.library} aria-label={label("文库", "Library")}>
        <div className={styles.libraryHeader}>
          <div className={styles.libraryTitle}><h2>{label("文库", "Library")}</h2><span>{label(`${state.documents.length} 份`, `${state.documents.length} docs`)}</span></div>
          <div className={styles.search}><Search aria-hidden="true" /><Input aria-label={label("搜索文库", "Search the library")} placeholder={label("搜索标题、来源…", "Search titles, sources…")} value={state.query} disabled={loading} onChange={(event) => setState((previous) => ({ ...previous, query: event.target.value }))} /></div>
          <Tabs value={state.filter} onValueChange={(value) => setState((previous) => ({ ...previous, filter: value as LibraryFilter }))}>
            <TabsList className={styles.filters} aria-label={label("文库筛选", "Library filter")}>
              {([ ["all", label("全部", "All")], ["read", label("已读", "Read")], ["unread", label("未读", "Unread")], ["starred", label("收藏", "Starred")] ] as const).map(([filter, title]) => <TabsTab key={filter} value={filter}>{title}{" "}<span>{counts[filter]}</span></TabsTab>)}
            </TabsList>
          </Tabs>
        </div>
        {loading ? <div className={styles.loading} role="status"><span>{label("正在读取文库…", "Reading the library…")}</span>{[0, 1, 2, 3].map((key) => <Skeleton key={key} className="h-28 w-full" />)}<Button variant="outline" onClick={() => setState(recoverLibrary)}>{label("完成本地读取", "Complete local read")}</Button></div> : (
          <ul ref={library} className={styles.documents} onScroll={(event) => { if (active) cache.set(`knowledge-base:${scenario}:library-scroll`, event.currentTarget.scrollTop) }}>
            {documents.map((item) => <li key={item.id}>
              <Item selected={item.id === state.selectedId} ariaLabel={copy(item.title)} onSelect={() => setState((previous) => selectDocument(previous, item.id))} className={styles.documentItem}
                title={<span className={styles.documentIdentity}><span className={styles.thumbnail} aria-hidden="true"><span /><span /><span /><span /><span /><small>{copy(item.title)}</small></span><span className={styles.documentMeta}><strong>{copy(item.title)}</strong><span>{copy(item.source)}</span><span>{copy(item.author)}</span><span>{copy(item.month)} · {label(`${item.pages} 页`, `${item.pages} pages`)}</span></span></span>}
                description={<span className={styles.progressBlock}><Progress className={styles.progress} value={item.page} min={0} max={item.pages} aria-label={label(`${copy(item.title)} 阅读进度`, `${copy(item.title)} reading progress`)} /><span>{label(`第 ${item.page} / ${item.pages} 页`, `Page ${item.page} / ${item.pages}`)} · {item.page === item.pages ? label("已完成", "Completed") : item.page === 1 ? label("未读", "Unread") : label(`剩余 ${item.minutes} 分钟`, `${item.minutes} min left`)}</span></span>}
                trailing={<Button className={styles.bookmark} variant="ghost" size="icon-sm" disabled={state.readonly} aria-label={label(`${state.starred.includes(item.id) ? "取消收藏" : "收藏"}${copy(item.title)}`, `${state.starred.includes(item.id) ? "Unstar" : "Star"} ${copy(item.title)}`)} aria-pressed={state.starred.includes(item.id)} onClick={() => setState((previous) => toggleDocumentStar(previous, item.id))}><Bookmark fill={state.starred.includes(item.id) ? "currentColor" : "none"} /></Button>} />
            </li>)}
            {!documents.length && <li className={styles.empty}><h3>{state.documents.length ? label("没有匹配的文档", "No matching documents") : label("文库为空", "The library is empty")}</h3><p>{state.documents.length ? label("更改筛选或搜索关键词。", "Change your filter or search terms.") : label("当前场景没有文档。可切换到默认场景阅读本地示例。", "This scenario has no documents. Switch to Default to read the local sample.")}</p>{state.documents.length > 0 && <Button variant="outline" onClick={() => setState((previous) => ({ ...previous, query: "", filter: "all" }))}>{label("清除筛选", "Clear filters")}</Button>}</li>}
          </ul>
        )}
      </section>
      <section ref={reader} className={styles.reader} aria-label={label("文档阅读器", "Document reader")} onScroll={(event) => { if (active) cache.set(scrollKey, event.currentTarget.scrollTop) }}>
        {loading ? <div className={styles.readerBody}><Skeleton className="h-8 w-1/2" /><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div> : document ? <div className={styles.readerBody}>
          <div className={styles.documentHeading}>
            <p className={styles.metadata}>{copy(document.source)} · {copy(document.month)} · {label(`${document.pages} 页`, `${document.pages} pages`)}</p>
            <h1>{copy(document.title)}</h1>
            <p className={styles.description}>{copy(document.description)}</p>
            <div className={styles.tags}>{document.tags.map((tag) => <span key={tag.en}>{copy(tag)}</span>)}</div>
          </div>
          <figure className={styles.passage} data-highlighted={highlighted} id={`passage-${scenario}-${document.id}`} aria-label={label(`关键段落 · ${highlighted ? "已高亮" : "未高亮"}`, `Key passage · ${highlighted ? "highlighted" : "not highlighted"}`)}>
            <blockquote>{highlighted ? <mark>{copy(document.passage)}</mark> : copy(document.passage)}</blockquote>
            <figcaption>{label(`关键段落 · ${highlighted ? "已高亮" : "未高亮"}`, `Key passage · ${highlighted ? "highlighted" : "not highlighted"}`)}</figcaption>
          </figure>
          {document.sections.map((section, index) => <section key={index} className={styles.prose} id={`section-${scenario}-${document.id}-${index}`}><h2>{copy(section.title)}</h2>{section.paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{copy(paragraph)}</p>)}</section>)}
          <div className={styles.actions} role="group" aria-label={label("文档操作", "Document actions")}>
            <Button variant="outline" size="sm" onClick={() => setState((previous) => answerDocumentQuestion(previous, { "zh-CN": "解释关键段落", en: "Explain the key passage" }, true))}><Bot />{label("解释", "Explain")}</Button>
            <Button variant="outline" size="sm" disabled={state.readonly} aria-pressed={highlighted} onClick={() => setState(togglePassageHighlight)}><Highlighter />{highlighted ? label("移除高亮", "Remove highlight") : label("高亮", "Highlight")}</Button>
            <Button variant="outline" size="sm" disabled={state.readonly} onClick={() => { setState((previous) => ({ ...previous, panel: "notes" })); requestAnimationFrame(() => noteInput.current?.focus()) }}><NotebookPen />{label("添加笔记", "Add Note")}</Button>
            <Button variant="outline" size="sm" disabled={state.readonly} aria-pressed={starred} onClick={() => setState((previous) => toggleDocumentStar(previous, document.id))}><Bookmark fill={starred ? "currentColor" : "none"} />{starred ? label("已收藏", "Saved") : label("收藏", "Save")}</Button>
            <Button variant="outline" size="sm" onClick={() => setState((previous) => ({ ...previous, citationId: previous.citationId === document.id ? null : document.id }))}><Quote />{label("生成引用", "Generate Citation")}</Button>
          </div>
          {state.citationId === document.id && <section className={styles.citation} aria-label={label("文档引用", "Document citation")}><div><h2>{label("引用", "Citation")}</h2><Button variant="ghost" size="icon-sm" aria-label={label("关闭引用", "Close citation")} onClick={() => setState((previous) => ({ ...previous, citationId: null }))}><X /></Button></div><p>{documentCitation(document, locale)}</p><p className={styles.metadata}>{label("根据当前本地文档元数据生成；可选择文本复制。", "Generated from the current local document metadata; select the text to copy.")}</p></section>}
          <Tabs value={state.panel} onValueChange={(value) => setState((previous) => ({ ...previous, panel: value as ReaderPanel }))} className={styles.readerPanel}>
            <TabsList aria-label={label("阅读器面板", "Reader panel")}><TabsTab value="notes">{label("笔记", "Notes")} {notes.length}</TabsTab><TabsTab value="highlights">{label("高亮", "Highlights")} {highlighted ? 1 : 0}</TabsTab></TabsList>
            <TabsPanel value="notes" keepMounted>
              {notes.length ? <ul className={styles.notes}>{notes.map((note) => <li key={note.id}><p>{note.text}</p><Button variant="ghost" size="icon-sm" disabled={state.readonly} aria-label={label("删除笔记", "Delete note")} onClick={() => setState((previous) => removeDocumentNote(previous, note.id))}><Trash2 /></Button></li>)}</ul> : <p className={styles.panelEmpty}>{label("这份文档还没有笔记。", "No notes on this document yet.")}</p>}
              <form className={styles.noteForm} onSubmit={(event) => { event.preventDefault(); setState(addDocumentNote) }}>
                <Input ref={noteInput} aria-label={label("添加笔记", "Add a note")} placeholder={label("添加笔记…", "Add a note…")} disabled={state.readonly} value={noteDraft} onChange={(event) => setState((previous) => ({ ...previous, noteDrafts: { ...previous.noteDrafts, [document.id]: event.target.value } }))} onKeyDown={(event) => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault() }} />
                <Button variant="outline" size="sm" type="submit" disabled={state.readonly || !noteDraft.trim()}>{label("添加", "Add")}</Button>
              </form>
            </TabsPanel>
            <TabsPanel value="highlights" keepMounted>{highlighted ? <div className={styles.highlightNote}><blockquote>{copy(document.passage)}</blockquote><Button variant="ghost" size="sm" onClick={() => reader.current?.querySelector("figure")?.scrollIntoView({ block: "center", behavior: "instant" })}>{label("定位段落", "Go to passage")}<ArrowRight /></Button></div> : <p className={styles.panelEmpty}>{label("这份文档还没有高亮。使用“高亮”标记关键段落。", "No highlights on this document yet. Use Highlight to mark the key passage.")}</p>}</TabsPanel>
          </Tabs>
          <section className={styles.related}><h2>{label("相关文档", "Related documents")}</h2><div>{document.related.map((id) => { const related = state.documents.find((item) => item.id === id); return related ? <Button variant="outline" size="sm" key={id} onClick={() => setState((previous) => selectDocument(previous, id))}>{copy(related.title)}<ArrowRight /></Button> : null })}</div></section>
          <p className={styles.readerStatus} role="status"><Check />{label("所有回答都引用你正在阅读的文档。", "All answers quote the document in front of you.")}</p>
        </div> : <div className={styles.empty}><h1>{label("选择一份文档", "Select a document")}</h1><p>{label("文库中的文档会在这里打开，供你阅读、标注与提问。", "Open a library document here to read, annotate, and ask questions.")}</p></div>}
      </section>
      <aside className={styles.ask} aria-label={label("向文库提问", "Ask the library")}>
        <div className={styles.askHeader}><Bot /><h2>{label("向文库提问", "Ask the library")}</h2><span>{label("本地回答 · 无模型", "Local answers · no model")}</span></div>
        <div className={styles.reading}>{label("正在阅读：", "Reading: ")}<strong>{document ? copy(document.title) : label("未选择文档", "No document selected")}</strong></div>
        <div ref={history} className={styles.history} role="log" aria-label={label("文档问答记录", "Document questions and answers")} aria-live="polite" onScroll={(event) => { if (!active) return; const element = event.currentTarget; followAnswers.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 64; cache.set(`knowledge-base:${scenario}:answer-scroll`, element.scrollTop) }}>
          <div className={styles.welcome}><Bot /><p>{label(`文库包含 ${state.documents.length} 份公司文档。我从你正在阅读的文档中回答——选择建议问题，或提出你自己的问题。`, `This library holds ${state.documents.length} company documents. I answer from the one you are reading — pick a suggested question or ask your own.`)}</p></div>
          {state.answers.map((answer) => {
            const source = state.documents.find((item) => item.id === answer.documentId)
            if (!source) return null
            if (answer.kind === "document-change") return <p key={answer.id} className={styles.documentChange}>{label(`— 正在阅读“${copy(source.title)}”。—`, `— Now reading “${copy(source.title)}”. —`)}</p>
            const question = typeof answer.question === "string" ? answer.question : copy(answer.question)
            const quote = copy(answerQuote(answer, source))
            const response = answer.found ? answer.kind === "explanation" ? copy(source.explanation) : label("文档中的相关原文：", "From the document:") : label("当前文档中没有找到对应内容。请使用建议问题，或查看以下关键段落。", "I could not find that topic in this document. Try a suggested question, or review the key passage below.")
            return <div key={answer.id} className={styles.answer}>
              <ChatMessage id={`${answer.id}-question`} role="user" content={question} />
              <ChatMessage id={answer.id} role="agent" author={label("本地文库", "Local library")} content={`${response}\n\n${quote}`} renderContent={() => <><p>{response}</p><blockquote>{quote}</blockquote></>} attachments={<Button className={styles.sourceButton} variant="ghost" size="sm" onClick={() => { setState((previous) => selectDocument(previous, source.id)); requestAnimationFrame(() => { const id = answer.sectionIndex === null ? `passage-${scenario}-${source.id}` : `section-${scenario}-${source.id}-${answer.sectionIndex}`; reader.current?.querySelector(`[id="${id}"]`)?.scrollIntoView({ block: "center", behavior: "instant" }) }) }}>{copy(source.title)} · {label(`第 ${answer.sourcePage} 页`, `p. ${answer.sourcePage}`)}<ArrowRight /></Button>} />
            </div>
          })}
        </div>
        <div className={styles.composer}>
          <div className={styles.suggestions}>{document?.suggestions.map((question) => <Button key={question.en} variant="outline" size="sm" disabled={loading} onClick={() => setState((previous) => answerDocumentQuestion(previous, question))}>{copy(question)}</Button>)}</div>
          <ChatComposer
            inputLabel={label("询问当前文档", "Ask about this document")}
            formLabel={label("向当前文档提问", "Ask the current document")}
            placeholder={document ? label(`询问${copy(document.title)}…`, `Ask about ${copy(document.title)}…`) : label("先选择文档…", "Select a document first…")}
            value={questionDraft}
            onChange={(text) => document && setState((previous) => ({ ...previous, questionDrafts: { ...previous.questionDrafts, [document.id]: text } }))}
            onSend={sendQuestion}
            disabled={!document || loading}
            sendLabel={label("发送问题", "Send question")}
            sendContent={<ArrowUp aria-hidden="true" />}
            textareaMinHeight={48}
            presentation="workspace"
          />
          <p><Bot />{label("回答引用你正在阅读的文档。", "Answers quote the document in front of you.")}</p>
        </div>
      </aside>
    </div></section>
  )
}
