import { z } from "zod";
import type { RemoteSettings } from "./chat.js";

export const chatDefaultSelectionSchema = z.object({
  providerInstanceId: z.string().trim().min(1).max(256),
  model: z.string().trim().min(1).max(256),
}).strict();
export type ChatDefaultSelection = z.infer<typeof chatDefaultSelectionSchema>;
export const chatDefaultsSchema = z.object({
  revision: z.number().int().nonnegative(),
  selection: chatDefaultSelectionSchema.nullable(),
}).strict();
export type ChatDefaults = z.infer<typeof chatDefaultsSchema>;
export const chatDefaultsUpdateSchema = chatDefaultsSchema;
export type ChatDefaultsResponse = {
  defaults: ChatDefaults;
  availability: { status: "unset" | "available" | "unavailable"; reason?: string };
};

/** An unset conversation is configurable, but cannot send until a pair is saved. */
export const UNSELECTED_THREAD_SETTINGS: Readonly<RemoteSettings> = Object.freeze({
  providerInstanceId: "",
  model: "",
  systemPrompt: "",
  temperature: 1,
});
