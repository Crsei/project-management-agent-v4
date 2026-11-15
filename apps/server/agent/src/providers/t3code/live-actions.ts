import { DurableError } from "../../durable/errors.ts";

export type LiveSteering = {
  generationId: string;
  threadId: string;
  interruptsTools: boolean;
  /** Must assert the original live Provider lease and turn immediately before native dispatch. */
  steer(input: { messageId: string; text: string }): Promise<void>;
};
const actions = new Map<string, LiveSteering>();
/** A live registration is owned by the original execution scope, never reconstructed after restart. */
export function registerLiveSteering(action: LiveSteering): () => void {
  if (actions.has(action.generationId)) throw new DurableError(409, "steering_owner_conflict", "Native steering already has an execution owner.");
  actions.set(action.generationId, action);
  return () => { if (actions.get(action.generationId) === action) actions.delete(action.generationId); };
}
export function getLiveSteering(generationId: string): LiveSteering | undefined {
  return actions.get(generationId);
}
