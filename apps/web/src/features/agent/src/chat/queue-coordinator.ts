import type { QueuedChatMessage } from "@agent-workspace/contracts/chat";

export type QueueGeneration = { id: string; messageId: string; status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted" };
export type QueueSnapshot = { messages: QueuedChatMessage[]; latest: QueueGeneration | null; headId: string | null; runtimeId: string };
export type QueuePauseReason = "not-resumed" | "hidden" | "server-restarted" | "history-changed" | "previous-failed" | "unknown" | "blocked" | "unavailable" | "empty" | "paused";
export type QueueDispatchPrecondition = { expectedHeadId: string | null; expectedGenerationId: string | null; confirmAfterGenerationId?: string };
/** Credentials are never retained here. Every send callback must perform a fresh authenticated HTTP request. */
export class ForegroundQueueCoordinator {
  private armed = false;
  private runtimeId: string | undefined;
  private expectedGenerationId: string | null = null;
  private expectedHeadId: string | null = null;
  private awaitingCompletion = false;
  private confirmAfterGenerationId: string | undefined;
  private sending = false;
  private disposed = false;
  private reason: QueuePauseReason = "not-resumed";
  private readonly send: (message: QueuedChatMessage, expected: QueueDispatchPrecondition) => Promise<{ generationId: string }>;
  private readonly onState: (state: { armed: boolean; reason?: QueuePauseReason }) => void;
  constructor(send: (message: QueuedChatMessage, expected: QueueDispatchPrecondition) => Promise<{ generationId: string }>,
    onState: (state: { armed: boolean; reason?: QueuePauseReason }) => void) {
    this.send = send;
    this.onState = onState;
  }
  private publish(): void { if (!this.disposed) this.onState({ armed: this.armed, ...(this.armed ? {} : { reason: this.reason }) }); }
  pause(reason: QueuePauseReason = "paused"): void { this.armed = false; this.reason = reason; this.publish(); }
  dispose(): void { this.disposed = true; this.armed = false; }
  /** Adding a new draft does not silently resume an older paused backlog. */
  enqueueIntent(snapshot: QueueSnapshot, queueId: string): void {
    if (this.disposed || this.armed) return;
    const first = snapshot.messages.find(row => row.status !== "sent" && row.status !== "removed");
    if (!first || first.id !== queueId) { this.pause("not-resumed"); return; }
    this.runtimeId = snapshot.runtimeId;
    this.expectedGenerationId = first.afterGenerationId ?? null;
    this.expectedHeadId = first.afterHeadId ?? null;
    this.awaitingCompletion = first.afterGenerationWasActive ?? (snapshot.latest?.status === "queued" || snapshot.latest?.status === "running");
    this.confirmAfterGenerationId = undefined;
    this.armed = true; this.publish();
  }
  /** Explicit Resume adopts a newly inspected boundary, never retries an unknown dispatch. */
  resume(snapshot: QueueSnapshot, confirmAfterGenerationId?: string): void {
    if (this.disposed) return;
    if (snapshot.messages.some(row => row.status === "dispatching" || row.status === "unknown")) { this.pause("unknown"); return; }
    if (snapshot.latest && !["queued", "running", "completed"].includes(snapshot.latest.status) && confirmAfterGenerationId !== snapshot.latest.id) { this.pause("previous-failed"); return; }
    this.runtimeId = snapshot.runtimeId;
    this.expectedGenerationId = snapshot.latest?.id ?? null;
    this.expectedHeadId = snapshot.headId;
    this.awaitingCompletion = snapshot.latest?.status === "queued" || snapshot.latest?.status === "running";
    this.confirmAfterGenerationId = confirmAfterGenerationId;
    this.armed = true; this.publish();
  }
  async advance(snapshot: QueueSnapshot): Promise<void> {
    if (this.disposed || !this.armed || this.sending) return;
    if (snapshot.runtimeId !== this.runtimeId) { this.pause("server-restarted"); return; }
    if (snapshot.messages.some(row => row.status === "unknown" || row.status === "dispatching")) { this.pause("unknown"); return; }
    const next = snapshot.messages.find(row => row.status !== "sent" && row.status !== "removed");
    if (!next) { this.pause("empty"); return; }
    if (next.status !== "queued" || !next.draft) { this.pause("blocked"); return; }
    if ((snapshot.latest?.id ?? null) !== this.expectedGenerationId) { this.pause("history-changed"); return; }
    if (snapshot.latest?.status === "running" || snapshot.latest?.status === "queued") return;
    if (snapshot.latest && snapshot.latest.status !== "completed" && this.confirmAfterGenerationId !== snapshot.latest.id) { this.pause("previous-failed"); return; }
    const expectedHead = this.awaitingCompletion && snapshot.latest?.status === "completed" ? snapshot.latest.messageId : this.expectedHeadId;
    if (snapshot.headId !== expectedHead) { this.pause("history-changed"); return; }
    this.sending = true;
    try {
      const accepted = await this.send(next, { expectedHeadId: snapshot.headId, expectedGenerationId: snapshot.latest?.id ?? null,
        ...(this.confirmAfterGenerationId ? { confirmAfterGenerationId: this.confirmAfterGenerationId } : {}) });
      if (!accepted.generationId) { this.pause("unknown"); return; }
      if (!this.disposed) { this.expectedGenerationId = accepted.generationId; this.awaitingCompletion = true; this.confirmAfterGenerationId = undefined; }
    } catch { this.pause("unavailable"); }
    finally { this.sending = false; }
  }
}
