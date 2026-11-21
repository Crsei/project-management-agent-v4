import type { Command } from "@contracts"

type JournalRecord = { key: string; scope: string; command: Command }

/** A copied tab identity must recover the occupied slot, never replace its command. */
export class PendingJournalCommandError extends Error {
  readonly command: Command

  constructor(command: Command) {
    super("A command in this tab's recovery slot still needs reconciliation")
    this.name = "PendingJournalCommandError"
    this.command = command
  }
}

/** IndexedDB accommodates the backend's 8 MiB uploads without Web Storage's small quota. */
export class PmCommandJournal {
  private database: Promise<IDBDatabase> | undefined
  private openAttempt = 0
  private readonly prefix: string
  private tabId: string | undefined

  constructor(instance: string) {
    this.prefix = `${instance}:`
  }

  private tabPrefix(): string {
    if (!this.tabId) {
      this.tabId = sessionStorage.getItem("pm-command-tab") ?? crypto.randomUUID()
      sessionStorage.setItem("pm-command-tab", this.tabId)
    }
    return `${this.prefix}${this.tabId}:`
  }

  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      const attempt = ++this.openAttempt
      const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>()
      this.database = promise
      let settled = false
      const settle = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback()
      }
      const reset = () => { if (this.openAttempt === attempt) this.database = undefined }
      const timer = setTimeout(() => {
        reset()
        settle(() => reject(new Error("Recovery storage did not open in time")))
      }, 1_500)
      let request: IDBOpenDBRequest
      try { request = indexedDB.open("pm-command-recovery", 1) }
      catch (error) { reset(); settle(() => reject(error)); return promise }
      request.onupgradeneeded = () => { request.result.createObjectStore("commands", { keyPath: "key" }) }
      request.onsuccess = () => {
        const database = request.result
        if (settled) { database.close(); return }
        database.onversionchange = () => { database.close(); if (this.database === promise) this.database = undefined }
        settle(() => resolve(database))
      }
      request.onerror = () => { reset(); settle(() => reject(request.error)) }
      request.onblocked = () => { reset(); settle(() => reject(new Error("Recovery storage is blocked"))) }
    }
    return this.database
  }

  async load(actorId: string): Promise<{ scope: string; command: Command }[]> {
    const database = await this.open()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("commands", "readonly")
      const records: { scope: string; command: Command }[] = []
      const prefix = `${this.tabPrefix()}${actorId}:`
      const request = transaction.objectStore("commands").openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`))
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        const record = cursor.value as JournalRecord
        records.push({ scope: record.scope, command: record.command })
        cursor.continue()
      }
      transaction.oncomplete = () => resolve(records)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  }

  async save(scope: string, command: Command): Promise<void> {
    const database = await this.open()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("commands", "readwrite")
      const store = transaction.objectStore("commands")
      const key = this.tabPrefix() + scope
      const request = store.get(key)
      request.onsuccess = () => {
        if (request.result) {
          reject(new PendingJournalCommandError((request.result as JournalRecord).command))
          transaction.abort()
          return
        }
        store.add({ key, scope, command } satisfies JournalRecord)
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  }

  async remove(scope: string, commandId: string): Promise<void> {
    const database = await this.open()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("commands", "readwrite")
      const store = transaction.objectStore("commands")
      const key = this.tabPrefix() + scope
      const request = store.get(key)
      request.onsuccess = () => {
        const record = request.result as JournalRecord | undefined
        if (record?.command.commandId.toLowerCase() === commandId.toLowerCase()) store.delete(key)
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  }

}
