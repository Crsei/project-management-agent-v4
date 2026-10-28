import { readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export type CursorOwnedProcess = { pid: number; startTime: string };
export type CursorProcessOwnerMessage =
  | { type: "worker-exit"; code: number | null; signal: NodeJS.Signals | null }
  | { type: "owner-killing"; members: CursorOwnedProcess[]; groupId: number };
type CursorProcessState = CursorOwnedProcess & { groupId: number; state: string };

function processState(pid: number): CursorProcessState | undefined {
  let stat: string;
  try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return undefined;
    throw error;
  }
  // comm is parenthesized and may itself contain spaces or closing parentheses.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  if (fields.length < 20) throw new Error("Could not identify an owned Cursor process.");
  return { pid, state: fields[0]!, groupId: Number(fields[2]), startTime: fields[19]! };
}

/** Called by the still-live detached group owner, never with a stale saved PID. */
export function cursorOwnedGroupMembers(groupId: number): CursorOwnedProcess[] {
  if (process.platform !== "linux") return [];
  const members: CursorOwnedProcess[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let state: CursorProcessState | undefined;
    try { state = processState(pid); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // hidepid may deny unrelated users' processes; our own worker group is
      // readable under the same UID. Never signal any PID discovered here.
      if (code === "EACCES" || code === "EPERM") continue;
      throw error;
    }
    if (state?.groupId === groupId && state.state !== "Z" && state.state !== "X")
      members.push({ pid, startTime: state.startTime });
  }
  return members;
}

/** Observation only: never signal a saved PID after its identity anchor exits. */
export async function waitForCursorOwnedProcesses(members: CursorOwnedProcess[], groupId?: number): Promise<void> {
  if (process.platform === "linux") {
    let remaining = members;
    while (remaining.length > 0) {
      remaining = remaining.filter((identity) => {
        const current = processState(identity.pid);
        return current?.startTime === identity.startTime && current.state !== "Z" && current.state !== "X";
      });
      if (remaining.length > 0) await delay(20);
    }
    return;
  }
  if (process.platform !== "win32" && groupId !== undefined) {
    // On other POSIX systems the owner has already sent group SIGKILL. A reused
    // group ID can only delay this observation; it is never signalled here.
    for (;;) {
      try { process.kill(-groupId, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        throw error;
      }
      await delay(20);
    }
  }
}
