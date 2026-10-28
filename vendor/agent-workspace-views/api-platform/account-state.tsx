"use client"
import {
  createContext,
  useContext,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from "react"
import type { ApScenario } from "./model"
import { ApStateProvider, useApState, type ApCache } from "./state"
import { createApAccountData, type ApAccountData } from "./fixtures/accounts"

const AccountContext = createContext<
  [ApAccountData, Dispatch<SetStateAction<ApAccountData>>] | null
>(null)
function AccountState({
  scenario,
  children,
}: {
  scenario: ApScenario
  children: ReactNode
}) {
  const state = useApState("account-domain", () =>
    createApAccountData(scenario),
  )
  return (
    <AccountContext.Provider value={state}>{children}</AccountContext.Provider>
  )
}
/** Host supplies one account cache per scenario/scope; page drafts use their own inner cache. */
export function ApAccountProvider({
  cache,
  scenario,
  children,
}: {
  cache: ApCache
  scenario: ApScenario
  children: ReactNode
}) {
  return (
    <ApStateProvider cache={cache}>
      <AccountState scenario={scenario}>{children}</AccountState>
    </ApStateProvider>
  )
}
export function useApAccountState() {
  const state = useContext(AccountContext)
  if (!state)
    throw new Error("AP2 account views require their Lab account provider")
  return state
}
