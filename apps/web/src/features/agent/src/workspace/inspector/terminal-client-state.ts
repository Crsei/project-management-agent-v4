export type TerminalClientIdentity = { clientId: string; inputSeq: number; acknowledgedSeq: number };
const identities = new Map<string, TerminalClientIdentity>();

/** One browser-tab identity and monotonic input sequence per service-owned PTY. */
export function terminalClientIdentity(terminalId: string, storage?: Storage): TerminalClientIdentity {
  const cached = identities.get(terminalId);
  if (cached) return cached;
  let clientId: string | null = null;
  let inputSeq = 0;
  try {
    clientId = storage?.getItem("pm-v4:terminal-client") ?? null;
    inputSeq = Number(storage?.getItem(`pm-v4:terminal-input:${terminalId}`) ?? 0);
  } catch { /* In-memory identity still prevents duplicate input during this attachment. */ }
  if (!clientId) {
    clientId = crypto.randomUUID();
    try { storage?.setItem("pm-v4:terminal-client", clientId); } catch { /* No storage permission. */ }
  }
  const identity = { clientId, inputSeq: Number.isSafeInteger(inputSeq) && inputSeq >= 0 ? inputSeq : 0, acknowledgedSeq: 0 };
  identities.set(terminalId, identity);
  return identity;
}

export function nextTerminalInput(identity: TerminalClientIdentity, terminalId: string, data: string, storage?: Storage) {
  const seq = ++identity.inputSeq;
  try { storage?.setItem(`pm-v4:terminal-input:${terminalId}`, String(seq)); } catch { /* No input is queued or resent. */ }
  return { type: "input" as const, seq, data };
}

/** Reconcile counters, never bytes: unreceived input is not replayed. */
export function reconcileTerminalInput(identity: TerminalClientIdentity, terminalId: string, acceptedInputSeq: number, storage?: Storage) {
  if (!Number.isSafeInteger(acceptedInputSeq) || acceptedInputSeq < 0) throw new Error("Invalid terminal input acknowledgment.");
  const unreceivedInput = identity.inputSeq > acceptedInputSeq;
  identity.inputSeq = acceptedInputSeq;
  identity.acknowledgedSeq = acceptedInputSeq;
  try { storage?.setItem(`pm-v4:terminal-input:${terminalId}`, String(acceptedInputSeq)); } catch { /* The next attachment reconciles from the server again. */ }
  return { unreceivedInput };
}

/** Sequence identity is independent of relative filenames, docking and attachment count. */
export function shouldRenderTerminalOutput(lastRendered: number, incoming: number) {
  return Number.isSafeInteger(incoming) && incoming > lastRendered;
}
