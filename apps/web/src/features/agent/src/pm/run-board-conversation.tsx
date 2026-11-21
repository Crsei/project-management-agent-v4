import { createContext, useContext, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"

type ConversationHost = {
  host: HTMLElement | null
  setHost: (node: HTMLElement | null) => void
}

const ConversationHostContext = createContext<ConversationHost | null>(null)

/** The board and its dock share one Chat runtime; the board only hosts the conversation. */
export function RunBoardConversationHostProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  return <ConversationHostContext.Provider value={{ host, setHost }}>{children}</ConversationHostContext.Provider>
}

export function RunBoardConversationPortal({ boardMode, children }: { boardMode: boolean; children: ReactNode }) {
  const context = useContext(ConversationHostContext)
  if (!boardMode) return <>{children}</>
  return context?.host ? createPortal(children, context.host) : null
}

export function useRunBoardConversationHost(): ((node: HTMLElement | null) => void) | undefined {
  return useContext(ConversationHostContext)?.setHost
}
