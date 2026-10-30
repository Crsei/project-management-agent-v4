import { useEffect, useState } from "react";
import { agentOutputFrameSchema, commandOutputFrameSchema, type AgentOutputSnapshot, type CommandOutputFrame } from "@agent-workspace/contracts/output";
import { workspaceClient } from "../network";
import { agentText } from "../i18n-text.ts";

/** Fetch-based SSE keeps every request on the authenticated workspace client. */
export async function readOutputStream<T>(path: string, signal: AbortSignal, parse: (data: unknown) => T, receive: (frame: T) => void): Promise<void> {
  const response = await workspaceClient.request(path, { signal, headers: { accept: "text/event-stream" } });
  if (!response.body) throw new Error(agentText("服务端未返回输出流。", "The server did not return an output stream."));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      // SSE permits CRLF and arbitrary network chunk boundaries.
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const block = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (data) receive(parse(JSON.parse(data)));
      }
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

const active = (status: AgentOutputSnapshot["status"]) => status === "queued" || status === "running";
export function useGenerationOutput(generationId: string) {
  const [snapshot, setSnapshot] = useState<AgentOutputSnapshot>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let current: AgentOutputSnapshot | undefined;
    let timer: number | undefined;
    let retry: number | undefined;
    let stopped = false;
    const flush = () => { timer = undefined; if (!stopped && current) setSnapshot({ ...current, items: [...current.items] }); };
    const schedule = (immediate = false) => {
      if (immediate) { clearTimeout(timer); flush(); }
      else if (!timer) timer = window.setTimeout(flush, 50);
    };
    const connect = async () => {
      try {
        await readOutputStream(`/api/chat/generations/${encodeURIComponent(generationId)}/output?after=${current?.sequence ?? 0}`, controller.signal, (data) => agentOutputFrameSchema.parse(data), (frame) => {
          if (frame.kind === "snapshot") {
            if (frame.snapshot.generationId !== generationId || (current && frame.snapshot.sequence < current.sequence)) return;
            current = frame.snapshot;
            setError(undefined);
            schedule(!active(current.status));
            return;
          }
          if (frame.generationId !== generationId || !current || frame.sequence <= current.sequence) return;
          if (frame.kind === "item") {
            const index = current.items.findIndex((item) => item.id === frame.item.id);
            const items = [...current.items];
            if (index < 0) items.push(frame.item); else items[index] = frame.item;
            current = { ...current, sequence: frame.sequence, items };
            schedule(!["pending", "running", "waiting"].includes(frame.item.status));
          } else {
            current = { ...current, sequence: frame.sequence, status: frame.status };
            schedule(!active(frame.status));
          }
        });
        if (current && !active(current.status)) return;
        throw new Error(agentText("输出流已断开，正在重新连接。", "The output stream disconnected; reconnecting."));
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        retry = window.setTimeout(() => void connect(), 1000);
      }
    };
    setSnapshot(undefined); setError(undefined); void connect();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); clearTimeout(retry); };
  }, [generationId]);
  return { snapshot, error };
}

export function subscribeCommand(generationId: string, itemId: string, signal: AbortSignal, receive: (frame: CommandOutputFrame) => void) {
  return readOutputStream(`/api/chat/generations/${encodeURIComponent(generationId)}/items/${encodeURIComponent(itemId)}/output`, signal, (data) => commandOutputFrameSchema.parse(data), receive);
}
