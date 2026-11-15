/**
 * Context kind/contextId vocabulary adapted from t3code composerContext.ts at
 * 7379f1969b0f4b579327cf81299ef8cc3ddf8e9c (MIT; see LICENSE.t3code).
 * Source verification, PM projection and persistence are host-owned contracts.
 */
import { z } from "zod";
import { pmAuthorizedOperationSchema, pmToolTargetSchema } from "./pm-tools.ts";

/** Context is evidence selected by the user, never an execution or PM permission grant. */
const id = z.string().trim().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const url = z.string().max(4096).url().refine(value => {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { return false; }
}, "Only HTTP(S) references without embedded credentials are supported.");
export const chatContextSelectionSchema = z.strictObject({
  startLine: z.number().int().positive(), endLine: z.number().int().positive(),
}).refine(value => value.endLine >= value.startLine, "Invalid line range.");
export type ChatContextSelection = z.infer<typeof chatContextSelectionSchema>;
export const chatContextAttachmentBindingSchema = z.strictObject({ attachmentId: id, partIndex: z.number().int().nonnegative().max(1999) });
const base = { contextId: id, comment: z.string().max(4000).optional() };
const nativeSource = z.strictObject({ type: z.literal("native-output"), threadId: id, generationId: id, itemId: id, contentDigest: digest.optional() });
const terminalSource = z.strictObject({ type: z.literal("terminal"), terminalId: id, serviceId: id, environmentDigest: digest.optional() });
const fileSource = z.strictObject({ type: z.literal("file"), path: z.string().min(1).max(4096), contentDigest: digest });
const diffSource = z.strictObject({ type: z.literal("diff"), path: z.string().min(1).max(4096), staged: z.boolean(), contentDigest: digest });
const prSource = z.strictObject({ type: z.literal("pull-request"), url });
const browserFields = {
  type: z.literal("browser"), url, selector: z.string().max(4000).optional(), title: z.string().max(512).optional(),
  captureId: id.optional(), attachmentId: id.optional(), tagName: z.string().max(256).optional(),
  rect: z.strictObject({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() }).optional(),
  devicePixelRatio: z.number().finite().positive().max(16).optional(), capturedAt: z.iso.datetime().optional(),
};
const browserSource = z.strictObject(browserFields);
const threadSource = z.strictObject({ type: z.literal("thread"), threadId: id, headMessageId: id, contentDigest: digest.optional() });
const environmentSource = z.strictObject({ type: z.literal("environment"), hostId: z.literal("local"), environmentDigest: digest.optional() });
const responseSource = z.strictObject({
  type: z.literal("response"), threadId: id, messageId: id, generationId: id.optional(), itemId: id.optional(), contentDigest: digest.optional(),
});
export const chatContextInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.literal("terminal"), source: z.union([terminalSource, nativeSource]),
    text: z.string().min(1).max(16000).optional(), terminalLabel: z.string().max(512).optional(), selection: chatContextSelectionSchema.optional() }),
  z.strictObject({ ...base, kind: z.literal("review-comment"), source: z.union([fileSource, diffSource, prSource]),
    selection: chatContextSelectionSchema.optional(), diffSelection: z.strictObject({
      start: z.number().int().positive(), end: z.number().int().positive(),
      side: z.enum(["old", "new", "deletions", "additions"]), endSide: z.enum(["old", "new", "deletions", "additions"]).optional(),
    }).optional() }),
  z.strictObject({ ...base, kind: z.literal("preview-annotation"), source: browserSource, text: z.string().max(16000) }),
  z.strictObject({ ...base, kind: z.literal("element"), source: z.strictObject({
    ...browserFields, selector: z.string().min(1).max(4000),
  }), text: z.string().max(16000) }),
  z.strictObject({ ...base, kind: z.literal("thread"), source: threadSource }),
  z.strictObject({ ...base, kind: z.literal("environment"), source: environmentSource }),
  z.strictObject({ ...base, kind: z.literal("response"), source: responseSource, selection: chatContextSelectionSchema.optional(), selectedText: z.string().min(1).max(16000).optional() }),
]);
export type ChatContextInput = z.infer<typeof chatContextInputSchema>;
const acceptedFields = {
  contextId: id, kind: z.enum(["terminal", "review-comment", "preview-annotation", "element", "thread", "environment", "response"]),
  digest, inputDigest: digest, truncated: z.boolean(), acceptedAt: z.iso.datetime(),
  provenance: z.enum(["server-verified", "user-terminal-snapshot", "user-browser-snapshot", "user-provided-url"]),
  reason: z.string().max(2000).optional(),
};
export const acceptedChatContextSchema = z.discriminatedUnion("visibility", [
  z.strictObject({
    ...acceptedFields, visibility: z.literal("available"),
    input: chatContextInputSchema, source: z.union([nativeSource, terminalSource, fileSource, diffSource, prSource, browserSource, threadSource, environmentSource, responseSource]),
    text: z.string().max(16000), terminalLabel: z.string().max(4096).optional(), label: z.string().max(512).optional(),
    dependencies: z.array(z.strictObject({ threadId: id, messageIds: z.array(id).max(10000) })).max(20).optional(),
    attachments: z.array(z.strictObject({ threadId: id, messageId: id, partIndex: z.number().int().nonnegative().max(1999), digest })).max(100).optional(),
    pmProvenance: z.strictObject({
      operationIds: z.array(z.string()).max(10000), targets: z.array(pmToolTargetSchema).max(10000),
      authorities: z.array(pmAuthorizedOperationSchema).max(10000).optional(), complete: z.boolean(),
    }).optional(),
  }),
  z.strictObject({
    ...acceptedFields, visibility: z.literal("unavailable"), source: z.strictObject({ type: z.literal("unavailable") }),
    input: z.undefined().optional(), text: z.literal(""), terminalLabel: z.undefined().optional(), label: z.undefined().optional(),
    dependencies: z.undefined().optional(), pmProvenance: z.undefined().optional(), attachments: z.undefined().optional(),
  }),
]);
export type AcceptedChatContext = z.infer<typeof acceptedChatContextSchema>;
export const chatContextResolveRequestSchema = z.strictObject({ contextItems: z.array(chatContextInputSchema).max(20) });
export const chatContextResolveResponseSchema = z.strictObject({ contextItems: z.array(acceptedChatContextSchema).max(20) });
export type ChatContextResolveRequest = z.infer<typeof chatContextResolveRequestSchema>;
export type ChatContextResolveResponse = z.infer<typeof chatContextResolveResponseSchema>;

/** Object key order is not snapshot identity; array order and every JSON value are. */
export function canonicalChatContextJson(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const entries = Object.entries(item);
      entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      return Object.fromEntries(entries);
    }
    return item;
  });
  if (encoded === undefined) throw new TypeError("Context digest input must be a JSON value.");
  return encoded;
}
