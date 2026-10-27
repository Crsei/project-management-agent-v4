import { ApiError, CommandOutcomeUnknown, type Command, type CommandReceipt, type ProjectManagementClient } from "@contracts"
import { asPmError, PmCommandError, PmServiceError } from "./pm-errors"
import { PendingJournalCommandError, PmCommandJournal } from "./pm-command-journal"

export type CommandState = {
  pending: boolean
  error: Error | null
  unknownCommand: Command | null
  receipt: CommandReceipt | null
}

type Entry = {
  state: CommandState
  completed: Map<string, { request: string; receipt: CommandReceipt }>
}

const emptyState: CommandState = { pending: false, error: null, unknownCommand: null, receipt: null }

/** One coordinator per provider, shared by every command surface in a workspace. */
export class PmCommandStore {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private readonly journal: PmCommandJournal
  private generation = 0
  private recoveryError: Error | null = null

  constructor(instance: string) {
    this.journal = new PmCommandJournal(instance)
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private entry(scope: string): Entry {
    let entry = this.entries.get(scope)
    if (!entry) {
      entry = { state: emptyState, completed: new Map() }
      this.entries.set(scope, entry)
    }
    return entry
  }

  async restore(actorId: string) {
    const generation = this.generation
    try {
      const records = await this.journal.load(actorId)
      if (generation !== this.generation) return
      this.recoveryError = null
      for (const record of records) {
        if (this.entries.get(record.scope)?.state.pending) continue
        const entry = this.entry(record.scope)
        this.update(entry, { unknownCommand: record.command, error: new PmServiceError("outcome_unknown") })
      }
    } catch {
      if (generation !== this.generation) return
      this.recoveryError = new PmServiceError("recovery_storage_unavailable")
      throw this.recoveryError
    }
  }

  getSnapshot = (scope: string | null): CommandState => scope ? this.entry(scope).state : emptyState

  private update(entry: Entry, state: Partial<CommandState>) {
    entry.state = { ...entry.state, ...state }
    for (const listener of this.listeners) listener()
  }

  clear(workspaceId?: string) {
    this.generation += 1
    for (const [scope, entry] of this.entries) {
      if (workspaceId && !scope.endsWith(`:${workspaceId}`)) continue
      this.entries.delete(scope)
      // A membership change drops receipts, but must not unlock an uncertain
      // write. Full identity changes hide everything until actor-scoped restore.
      const original = entry.state.unknownCommand
      if (workspaceId && original) this.entries.set(scope, { state: { ...emptyState, unknownCommand: original, error: new PmServiceError("outcome_unknown") }, completed: new Map() })
    }
    // The journal is recovery intent, not a query cache. Logout/revocation must
    // not erase a possibly committed command, including another tab's record.
    for (const listener of this.listeners) listener()
  }

  private forget(scope: string, commandId: string) {
    // A stale journal is conservative; a late response must not remove another tab's command.
    void this.journal.remove(scope, commandId).catch(() => {})
  }

  async execute(scope: string, workspaceId: string, command: Command, client: ProjectManagementClient, settled: (receipt: CommandReceipt) => void, failed: (error: Error) => void): Promise<CommandReceipt> {
    const entry = this.entry(scope)
    if (this.recoveryError) throw this.recoveryError
    if (entry.state.pending) throw new PmServiceError("command_pending")
    if (entry.state.unknownCommand) throw new CommandOutcomeUnknown(workspaceId, entry.state.unknownCommand.commandId, entry.state.error)
    const original = structuredClone(command)
    const request = JSON.stringify(original)
    const cached = entry.completed.get(original.commandId.toLowerCase())
    if (cached) {
      if (cached.request !== request) throw new PmServiceError("idempotency_conflict")
      if (cached.receipt.status === "rejected") throw new PmCommandError(cached.receipt, original)
      return cached.receipt
    }
    // Persist before dispatch: a reload or dropped response must not lose the ID,
    // payload or expectedVersions. A quota failure never sends a write.
    this.update(entry, { pending: true, error: null, receipt: null })
    try { await this.journal.save(scope, original) }
    catch (cause) {
      if (cause instanceof PendingJournalCommandError) {
        if (this.entries.get(scope) !== entry) throw new PmServiceError("session_changed")
        const error = new CommandOutcomeUnknown(workspaceId, cause.command.commandId, cause)
        this.update(entry, { pending: false, unknownCommand: cause.command, error })
        throw error
      }
      const error = new PmServiceError("recovery_storage_unavailable")
      if (this.entries.get(scope) === entry) this.update(entry, { pending: false, error })
      throw error
    }
    if (this.entries.get(scope) !== entry) throw new PmServiceError("session_changed")
    try {
      // Deliberately no React Query mutation retry or transport retry.
      const receipt = await client.executeCommand(workspaceId, original)
      if (this.entries.get(scope) !== entry) throw new PmServiceError("session_changed")
      this.forget(scope, original.commandId)
      entry.completed.set(original.commandId.toLowerCase(), { request, receipt })
      this.update(entry, { receipt, unknownCommand: null })
      settled(receipt)
      if (receipt.status === "rejected") throw new PmCommandError(receipt, original)
      return receipt
    } catch (cause) {
      const error = asPmError(cause)
      if (this.entries.get(scope) === entry) {
        if (error instanceof CommandOutcomeUnknown) this.update(entry, { unknownCommand: original, error })
        else { this.forget(scope, original.commandId); this.update(entry, { error }) }
        failed(error)
      }
      throw error
    } finally {
      if (this.entries.get(scope) === entry) this.update(entry, { pending: false })
    }
  }

  async reconcile(scope: string, workspaceId: string, client: ProjectManagementClient, settled: (receipt: CommandReceipt) => void, failed: (error: Error) => void): Promise<CommandReceipt | undefined> {
    const entry = this.entry(scope)
    if (entry.state.pending) throw new PmServiceError("command_pending")
    const original = entry.state.unknownCommand
    if (!original) return
    this.update(entry, { pending: true, error: null })
    try {
      const receipt = await client.getCommandReceipt(workspaceId, original.commandId)
      if (this.entries.get(scope) !== entry) throw new PmServiceError("session_changed")
      this.forget(scope, original.commandId)
      entry.completed.set(original.commandId.toLowerCase(), { request: JSON.stringify(original), receipt })
      this.update(entry, { receipt, unknownCommand: null })
      settled(receipt)
      if (receipt.status === "rejected") throw new PmCommandError(receipt, original)
      return receipt
    } catch (cause) {
      const error = asPmError(cause)
      if (this.entries.get(scope) === entry) {
        // 404 intentionally conflates missing and inaccessible. Neither proves
        // that a command failed, so retain the original recovery record.
        this.update(entry, { error: error instanceof ApiError && error.status === 404 ? new PmServiceError("receipt_unavailable") : error })
        failed(error)
      }
      if (error instanceof ApiError && error.status === 404) return
      throw error
    } finally {
      if (this.entries.get(scope) === entry) this.update(entry, { pending: false })
    }
  }
}
