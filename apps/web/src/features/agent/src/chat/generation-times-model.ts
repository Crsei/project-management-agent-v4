import type { ChatGenerationView } from "@agent-workspace/contracts/chat";
export type MessageTimes = ReadonlyMap<string, string>;
/** Map both the input user message and the assistant message to the generation start. */
export function indexMessageTimes(generations: readonly Pick<ChatGenerationView, "inputMessageId" | "messageId" | "createdAt">[]): Map<string, string> {
  const times = new Map<string, string>();
  for (const generation of generations) {
    if (generation.inputMessageId) times.set(generation.inputMessageId, generation.createdAt);
    if (generation.messageId) times.set(generation.messageId, generation.createdAt);
  }
  return times;
}
