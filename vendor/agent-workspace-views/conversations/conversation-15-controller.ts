"use client"
import { useState, type Dispatch, type SetStateAction } from "react"
import type { ComposerDemoController } from "../demo-controller"
import { useThreadController, type ThreadController } from "./shared"
import type {
  Conversation15Fixture,
  Conversation15Scenario,
  SupportTicket,
} from "./conversation-15-fixtures"
export interface Conversation15Controller extends ComposerDemoController {
  readState: ThreadController["readState"]
  setReadState: ThreadController["setReadState"]
  tickets: SupportTicket[]
  selectedTickets: string[]
  setSelectedTickets: Dispatch<SetStateAction<string[]>>
  ticketId: string
  setTicketId: Dispatch<SetStateAction<string>>
  ticket: SupportTicket | undefined
  filterText: string
  setFilterText: Dispatch<SetStateAction<string>>
  filtered: SupportTicket[]
  insight: number
  setInsight: Dispatch<SetStateAction<number>>
  owner: string
  setOwner: Dispatch<SetStateAction<string>>
  responseTarget: string
  setResponseTarget: Dispatch<SetStateAction<string>>
  trend: Conversation15Fixture["trend"]
  unknown: boolean
  notice: boolean
  reconcile: () => void
  assign: () => void
}
export function useConversation15Controller(
  fixture: Conversation15Fixture,
  scenario: Conversation15Scenario,
  active: boolean,
): Conversation15Controller {
  const base = useThreadController(
    {
      ...fixture.source,
      initialReadingPosition: scenario === "long" ? "start" : "latest",
    },
    scenario,
    active,
  )
  const [tickets, setTickets] = useState(() => structuredClone(fixture.tickets))
  const [selectedTickets, setSelectedTickets] = useState<string[]>(
    fixture.tickets.map((ticket) => ticket.id),
  )
  const [ticketId, setTicketId] = useState(fixture.tickets[0]?.id ?? "")
  const [filterText, setFilterText] = useState("")
  const [insight, setInsight] = useState(0)
  const [owner, setOwner] = useState("")
  const [responseTarget, setResponseTarget] = useState("today-17")
  const [unknown, setUnknown] = useState(scenario === "unknown")
  const [notice, setNotice] = useState(false)
  return {
    ...base,
    tickets,
    selectedTickets,
    setSelectedTickets,
    ticketId,
    setTicketId,
    filterText,
    setFilterText,
    insight,
    setInsight,
    owner,
    setOwner,
    responseTarget,
    setResponseTarget,
    trend: fixture.trend,
    unknown,
    notice,
    ticket: tickets.find((ticket) => ticket.id === ticketId),
    filtered: tickets.filter((ticket) =>
      (ticket.id + ticket.account + ticket.subject["zh-CN"] + ticket.subject.en)
        .toLocaleLowerCase()
        .includes(filterText.toLocaleLowerCase()),
    ),
    reconcile: () => {
      setUnknown(false)
      base.focusComposer()
    },
    assign: () => {
      if (unknown || !selectedTickets.length || !owner) return
      setTickets((previous) =>
        previous.map((ticket) =>
          selectedTickets.includes(ticket.id)
            ? { ...ticket, owner, responseTarget, status: "assigned" }
            : ticket,
        ),
      )
      setNotice(true)
    },
  }
}
