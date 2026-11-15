import { createHash } from "node:crypto";
import type { UIMessage } from "ai";
import { acceptedChatContextSchema, canonicalChatContextJson, chatContextAttachmentBindingSchema, chatContextResolveRequestSchema, type AcceptedChatContext, type ChatContextInput, type ChatContextSelection } from "@agent-workspace/contracts/message-context";
import type { ExecutionEnvironment } from "@agent-workspace/contracts/chat";
import type { NativeOutputItem } from "@agent-workspace/contracts/output";
import { createPmVisibilityProjector, pmPayloadTargets, type PmContentProvenance, type PmVisibilityProjector } from "../pm-visibility.ts";
import { resolveChatExecutionScope } from "../task-delivery/binding.ts";
import { assertMcpThread, mcpIdentityFromHeaders } from "../mcp/identity.ts";
import { readInspectorProjection } from "../inspector/scope.ts";
import { readFile } from "../inspector/files.ts";
import { readDiff } from "../inspector/git.ts";
import { resolveInsideRoot } from "../inspector/paths.ts";
import { authorizeTerminalContext } from "../inspector/terminal.ts";
import { getNativeOutput } from "./native-output.ts";
import { getThread, getThreadBranch, getThreadHistory, type StoredMessage } from "./threads.ts";
import { getDatabase, listRecords } from "./store.ts";
import { DurableError } from "./errors.ts";
import { validateChatAttachments } from "../providers/chat-attachments.ts";

export const contextDigest = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : canonicalChatContextJson(value)).digest("hex");
const MAX_ITEM = 16000, MAX_TOTAL = 48000;
const unavailable = (reason: string): never => { throw new DurableError(409, "context_unavailable", reason); };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function executionEnvironmentContextDigest(environment: ExecutionEnvironment): string {
  return contextDigest({ hostId: environment.hostId, agentWorkspaceId: environment.agentWorkspaceId,
    agentWorkspaceRevision: environment.agentWorkspaceRevision, sourcePath: environment.sourcePath,
    executionPath: environment.executionPath, worktree: environment.worktree });
}

/** Only explicit server-owned stash/queue/history acceptance can prove an expired PTY selection. */
function savedTerminalSnapshot(threadId: string, input: ChatContextInput): Extract<AcceptedChatContext, { visibility: "available" }> | undefined {
  const inputDigest = contextDigest(input);
  const match = "json_extract(context.value,'$.kind')='terminal' AND json_extract(context.value,'$.inputDigest')=?";
  const queries = [
    `SELECT context.value AS snapshot FROM records, json_each(records.value,'$.acceptedContextItems') AS context
      WHERE records.namespace IN ('chat:message-queue','chat:draft-stash') AND json_extract(records.value,'$.threadId')=?
      AND json_type(records.value,'$.draft')='object' AND coalesce(json_extract(records.value,'$.removed'),0)=0
      AND coalesce(json_extract(records.value,'$.status'),'')!='removed' AND ${match} LIMIT 20`,
    `SELECT context.value AS snapshot FROM records, json_each(records.value,'$.messages') AS message,
      json_each(message.value,'$.turnContext.contextItems') AS context
      WHERE records.namespace='chat:history' AND json_extract(records.value,'$.threadId')=? AND ${match} LIMIT 20`,
  ];
  for (const query of queries) for (const row of getDatabase().prepare(query).all(threadId, inputDigest)) {
    const parsed = acceptedChatContextSchema.safeParse(JSON.parse(String(row.snapshot)));
    if (!parsed.success || parsed.data.visibility !== "available") continue;
    const snapshot = parsed.data;
    if (snapshot.kind !== "terminal" || snapshot.input.kind !== "terminal" || snapshot.source.type !== "terminal" ||
        snapshot.input.source.type !== "terminal" || snapshot.provenance !== "user-terminal-snapshot" ||
        !snapshot.terminalLabel || snapshot.pmProvenance || snapshot.inputDigest !== contextDigest(snapshot.input) ||
        snapshot.digest !== contextDigest(snapshot.text) || snapshot.text !== snapshot.input.text ||
        snapshot.contextId !== snapshot.input.contextId || canonicalChatContextJson(snapshot.source) !== canonicalChatContextJson(snapshot.input.source) ||
        snapshot.dependencies?.length !== 1 || snapshot.dependencies[0]!.threadId !== threadId || snapshot.dependencies[0]!.messageIds.length !== 0) continue;
    return snapshot;
  }
  return undefined;
}
export function selectContextLines(text: string, selection?: ChatContextSelection): string {
  if (!selection) return text;
  const lines = text.split("\n");
  if (selection.startLine < 1 || selection.endLine < selection.startLine || selection.endLine > lines.length)
    throw new DurableError(409, "context_selection_changed", "Selected lines no longer exist; select the source again.");
  return lines.slice(selection.startLine - 1, selection.endLine).join("\n");
}
function verifyDiffSelection(patch: string, input: Extract<ChatContextInput, { kind: "review-comment" }>): void {
  const range = input.diffSelection;
  if (!range) return;
  if (input.source.type !== "diff" || !input.selection)
    throw new DurableError(400, "invalid_context_selection", "Diff side coordinates require the exact selected raw patch range.");
  const side = (value: string) => value === "old" || value === "deletions" ? "old" : "new";
  let old = 0, current = 0, oldRemaining = 0, currentRemaining = 0;
  let start: number | undefined, end: number | undefined;
  for (const [index, line] of patch.split("\n").entries()) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) { old = Number(hunk[1]); oldRemaining = Number(hunk[2] ?? 1); current = Number(hunk[3]); currentRemaining = Number(hunk[4] ?? 1); continue; }
    if (line.startsWith("\\") || oldRemaining + currentRemaining === 0) continue;
    const prefix = line[0];
    if (prefix !== " " && prefix !== "+" && prefix !== "-") { oldRemaining = 0; currentRemaining = 0; continue; }
    const hasOld = prefix !== "+" && oldRemaining > 0, hasCurrent = prefix !== "-" && currentRemaining > 0;
    const matches = (value: number, at: string) => at === "old" ? hasOld && old === value : hasCurrent && current === value;
    if (matches(range.start, side(range.side))) start = index + 1;
    if (matches(range.end, side(range.endSide ?? range.side))) end = index + 1;
    if (hasOld) { old++; oldRemaining--; }
    if (hasCurrent) { current++; currentRemaining--; }
  }
  if (start === undefined || end === undefined || Math.min(start, end) !== input.selection.startLine || Math.max(start, end) !== input.selection.endLine)
    throw new DurableError(409, "context_selection_changed", "Diff side/line coordinates do not match the selected SHA-bound patch lines.");
}
/** Render actual saved native fields; never reread current files or manufacture a diff/search result. */
function nativeItemContextText(item: NativeOutputItem): string {
  const blocks = [item.text, item.output].filter((value): value is string => Boolean(value));
  if (item.type === "file_change") {
    if (item.fileName) blocks.push(item.fileName);
    if (item.diff) blocks.push(item.diff);
    if (item.oldText !== undefined) blocks.push(`Original source:\n${item.oldText}`);
    if (item.newText !== undefined) blocks.push(`New source:\n${item.newText}`);
    for (const change of item.changes ?? [])
      blocks.push([change.oldPath ? `${change.oldPath} → ${change.path}` : change.path, change.operation, change.diff].filter(Boolean).join("\n"));
  }
  for (const result of item.results ?? [])
    blocks.push([result.title, result.path ? `${result.path}${result.line !== undefined ? `:${result.line}` : ""}` : undefined, result.url, result.text].filter(Boolean).join("\n"));
  for (const step of item.steps ?? []) blocks.push(`[${step.status}] ${step.text}`);
  if (item.error) blocks.push(item.error);
  if (!blocks.length && item.input !== undefined) {
    const text = JSON.stringify(item.input, null, 2);
    if (text !== undefined) blocks.push(text);
  }
  if (!blocks.length && item.title) blocks.push(item.title);
  return blocks.join("\n\n");
}
export async function authorizeContextThread(threadId: string, headers: Headers) {
  const thread = getThread(threadId);
  if (!thread || thread.deletionState) return unavailable("The context source Session is unavailable.");
  const identity = mcpIdentityFromHeaders(headers);
  if (identity) await assertMcpThread(identity, threadId);
  await resolveChatExecutionScope(thread, headers, "inspect");
  return thread;
}
function messageText(message: StoredMessage, includeLegacyQuote = false): string {
  const parts = message.content.parts;
  const text = Array.isArray(parts) ? parts.flatMap(part => object(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n") : "";
  const metadata = object(message.content.metadata) ? message.content.metadata : {};
  const custom = object(metadata.custom) ? metadata.custom : {};
  const quote = object(custom.quote) ? custom.quote : undefined;
  return includeLegacyQuote && typeof quote?.text === "string"
    ? `${text}\n\nUser-provided legacy quote (not verified against its original source):\n${quote.text.slice(-MAX_ITEM)}` : text;
}
type SourceGeneration = { id: string; threadId: string; messageId: string; status: string; createdAt?: string; output?: UIMessage };
function stableGeneration(values: readonly SourceGeneration[], generationId?: string): SourceGeneration {
  const candidates = values.filter(value => !generationId || generationId === value.id)
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  if (!generationId && candidates.some(value => value.status === "queued" || value.status === "running"))
    return unavailable("The source response is still changing; select a settled generation.");
  if (!generationId && candidates.length > 1 && candidates[0]!.createdAt === candidates[1]!.createdAt)
    return unavailable("The response boundary is ambiguous; select its explicit generation.");
  const generation = candidates[0];
  if (!generation || !["completed", "failed", "cancelled", "interrupted"].includes(generation.status))
    return unavailable("Select a saved, settled response boundary.");
  return generation;
}
function generationMessage(generation: SourceGeneration, saved: StoredMessage | undefined): StoredMessage {
  if (!saved || saved.content.role !== "assistant" || !generation.output || generation.output.id !== generation.messageId || generation.output.role !== "assistant" || !Array.isArray(generation.output.parts))
    return unavailable("The source has no immutable server-owned response snapshot.");
  const { id: _id, ...content } = generation.output;
  return { ...saved, content };
}
function mergeProvenance(...values: PmContentProvenance[]): PmContentProvenance {
  return { operationIds: [...new Set(values.flatMap(value => value.operationIds))],
    targets: [...new Map(values.flatMap(value => value.targets).map(target => [JSON.stringify(target), target])).values()],
    authorities: [...new Map(values.flatMap(value => value.authorities ?? []).map(authority => [JSON.stringify(authority), authority])).values()] };
}
/** Resolve only explicit real source identities. Browser/PTY text is explicitly user-provided, never a server observation. */
export async function resolveChatContextItems(threadId: string, inputs: ChatContextInput[], headers: Headers): Promise<AcceptedChatContext[]> {
  const parsed = chatContextResolveRequestSchema.parse({ contextItems: inputs }).contextItems;
  if (new Set(parsed.map(input => input.contextId)).size !== parsed.length)
    throw new DurableError(400, "duplicate_context", "Context identities must be unique.");
  const destination = await authorizeContextThread(threadId, headers);
  const result: AcceptedChatContext[] = [];
  for (const input of parsed) {
    const source = input.source;
    let acceptedInput = input, acceptedSource = source;
    let text = "", truncated = false;
    let provenance: AcceptedChatContext["provenance"] = "server-verified";
    let dependencies: AcceptedChatContext["dependencies"] = [{ threadId, messageIds: [] }];
    let pmProvenance: AcceptedChatContext["pmProvenance"];
    let attachments: AcceptedChatContext["attachments"];
    let label: string | undefined;
    let terminalLabel: string | undefined;
    let acceptedAt: string | undefined, reason: string | undefined;
    let nativeItemDigest: string | undefined;
    if (input.kind === "preview-annotation" || input.kind === "element") {
      label = input.source.title?.slice(0, 512);
      text = input.text;
      provenance = "user-browser-snapshot";
      // No navigation, DNS lookup, screenshot generation or URL fetch occurs here.
    } else if (input.kind === "terminal" && source.type === "terminal") {
      if (!input.text?.trim()) return unavailable("Select actual terminal text before adding it.");
      const execution = await resolveChatExecutionScope(destination, headers, "inspect");
      if (!execution.environment) return unavailable("The selected terminal's execution environment is unavailable.");
      const environmentDigest = executionEnvironmentContextDigest(execution.environment);
      if (source.environmentDigest && source.environmentDigest !== environmentDigest)
        throw new DurableError(409, "context_source_changed", "The selected terminal's Session environment changed; select and confirm its source again.");
      try {
        const descriptor = await authorizeTerminalContext(threadId, source.terminalId, source.serviceId, headers);
        terminalLabel = descriptor.startCwd;
        label = descriptor.startCwd.slice(0, 512);
      } catch (error) {
        if (!(error instanceof DurableError) || !["terminal_unavailable", "terminal_expired"].includes(error.code) || !source.environmentDigest) throw error;
        const snapshot = savedTerminalSnapshot(threadId, input);
        if (!snapshot) throw error;
        terminalLabel = snapshot.terminalLabel; label = snapshot.label; acceptedAt = snapshot.acceptedAt;
        reason = "This is a previously accepted user-selected terminal snapshot. The original PTY is unavailable; it was not restored or rerun.";
      }
      acceptedInput = { ...input, source: { ...source, environmentDigest } }; acceptedSource = acceptedInput.source;
      text = input.text;
      provenance = "user-terminal-snapshot";
    } else if (input.kind === "review-comment" && (source.type === "file" || source.type === "diff")) {
      const url = new URL("http://localhost/inspector"); url.searchParams.set("threadId", threadId);
      const snapshot = await readInspectorProjection(url, headers, async root => {
        if (source.type === "file") {
          const file = await readFile(source.path, root);
          return { text: file.content, truncated: file.truncated };
        }
        const path = await resolveInsideRoot(source.path, root);
        const diff = await readDiff(root, path.relative, source.staged);
        if (!diff) return unavailable("This Session has no Git repository.");
        return { text: diff.patch, truncated: diff.truncated };
      });
      if (contextDigest(snapshot.text) !== source.contentDigest)
        throw new DurableError(409, "context_source_changed", "File or patch changed; select and confirm the current source again.");
      if (input.diffSelection) verifyDiffSelection(snapshot.text, input);
      text = selectContextLines(snapshot.text, input.selection);
      label = source.path.slice(0, 512);
      truncated = snapshot.truncated;
    } else if (input.kind === "review-comment" && source.type === "pull-request") {
      if (input.selection || input.diffSelection)
        throw new DurableError(400, "invalid_context_selection", "A user-provided PR URL has no verified file or diff line range.");
      text = `User-provided pull-request URL (remote metadata not queried): ${source.url}`;
      label = source.url.slice(0, 512);
      provenance = "user-provided-url";
    } else if (input.kind === "environment") {
      const snapshot = await resolveChatExecutionScope(destination, headers, "inspect");
      if (!snapshot.environment) return unavailable("The local execution environment is unavailable.");
      const environment = snapshot.environment;
      const environmentDigest = executionEnvironmentContextDigest(environment);
      if (input.source.environmentDigest && input.source.environmentDigest !== environmentDigest)
        throw new DurableError(409, "context_source_changed", "The selected execution environment changed; select and confirm it again.");
      acceptedInput = { ...input, source: { ...input.source, environmentDigest } };
      acceptedSource = acceptedInput.source;
      text = JSON.stringify(snapshot.environment, null, 2);
      label = "Local";
    } else if (source.type === "thread" || source.type === "response" || source.type === "native-output") {
      const sourceThread = await authorizeContextThread(source.threadId, headers);
      const projector = await createPmVisibilityProjector(source.threadId, headers);
      label = (projector.nativeContextContaminated ? source.threadId : sourceThread.title || source.threadId).slice(0, 512);
      let messages: StoredMessage[];
      let sourceGenerationId: string | undefined;
      const sourceHistory = getThreadHistory(source.threadId);
      const savedMessages = new Map(sourceHistory.messages.map(message => [message.id, message]));
      const generations = listRecords<SourceGeneration>("chat:generations").filter(value => value.threadId === source.threadId);
      const generationIds = new Map(generations.map(value => [value.id, value]));
      const generationMessages = new Map<string, SourceGeneration[]>();
      for (const generation of generations) {
        const entries = generationMessages.get(generation.messageId);
        if (entries) entries.push(generation); else generationMessages.set(generation.messageId, [generation]);
      }
      if (source.type === "thread") {
        if (!savedMessages.has(source.headMessageId)) return unavailable("The frozen source head is missing.");
        messages = getThreadBranch(source.threadId, source.headMessageId).map(message => {
          if (message.content.role === "assistant") return generationMessage(stableGeneration(generationMessages.get(message.id) ?? []), message);
          if (message.content.role === "user" && message.turnContext) return message;
          return unavailable("The source branch contains unaccepted imported content.");
        });
      } else {
        const generation = source.type === "native-output"
          ? generationIds.get(source.generationId)
          : stableGeneration(generationMessages.get(source.messageId) ?? [], source.generationId);
        if (!generation || !["completed", "failed", "cancelled", "interrupted"].includes(generation.status)) return unavailable("Native source has not settled.");
        sourceGenerationId = generation.id;
        messages = [generationMessage(generation, savedMessages.get(generation.messageId))];
      }
      const visible = projector.history(messages);
      if (visible.some(message => object(message.content.metadata) && message.content.metadata.pmVisibility || message.turnContext?.contextItems?.some(item => item.visibility !== "available")))
        throw new DurableError(403, "context_forbidden", "The source includes content that is not currently readable.");
      if (source.type === "thread") {
        const selectedAttachments = new Map<string, NonNullable<AcceptedChatContext["attachments"]>[number]>();
        for (const message of visible) {
          const parts = message.content.parts;
          if (Array.isArray(parts)) for (let partIndex = 0; partIndex < parts.length; partIndex++) {
            const part = parts[partIndex];
            if (!object(part) || part.type !== "file") continue;
            const attachment = { threadId: source.threadId, messageId: message.id, partIndex, digest: contextDigest(part) };
            selectedAttachments.set(JSON.stringify(attachment), attachment);
            if (selectedAttachments.size > 100) throw new DurableError(413, "context_too_large", "Selected thread contains more than 100 attachment references.");
          }
          for (const context of message.turnContext?.contextItems ?? []) for (const attachment of context.attachments ?? []) {
            selectedAttachments.set(JSON.stringify(attachment), attachment);
            if (selectedAttachments.size > 100) throw new DurableError(413, "context_too_large", "Selected thread contains more than 100 attachment references.");
          }
        }
        attachments = [...selectedAttachments.values()];
      }
      if (source.type !== "thread" && source.itemId) {
        const generation = source.type === "native-output" ? source.generationId : sourceGenerationId!;
        const raw = getNativeOutput(generation);
        if (!raw || raw.threadId !== source.threadId) return unavailable("Native output is missing.");
        const item = projector.nativeSnapshot(raw).items.find(item => item.id === source.itemId);
        if (!item || item.visibility && item.visibility !== "visible") return unavailable("The selected native item is unavailable.");
        if (input.kind === "terminal" && item.type !== "command_execution") return unavailable("Terminal references require a real command output item.");
        if (input.kind === "terminal") terminalLabel = item.title || item.id;
        text = nativeItemContextText(item);
        nativeItemDigest = contextDigest(item);
        truncated = item.outputTruncated ?? false;
      } else if (source.type === "thread") {
        const blocks: string[] = [];
        let remaining = MAX_ITEM;
        for (let index = visible.length - 1; index >= 0; index--) {
          const message = visible[index]!;
          const block = `${message.content.role} [${message.id}]\n${messageText(message, true)}${contextPromptText(message.turnContext?.contextItems)}`;
          if (block.length > remaining) { blocks.unshift(block.slice(-remaining)); truncated = true; break; }
          blocks.unshift(block); remaining -= block.length + 2;
          if (remaining <= 0) { truncated = index > 0; break; }
        }
        text = blocks.join("\n\n");
      } else text = visible.map(message => messageText(message)).join("\n\n");
      const contentDigest = contextDigest({ text, truncated, attachments: attachments ?? [], ...(nativeItemDigest ? { nativeItemDigest } : {}) });
      if (source.contentDigest && source.contentDigest !== contentDigest)
        throw new DurableError(409, "context_source_changed", "The frozen source snapshot changed; select and confirm its current boundary.");
      if (input.kind === "thread" && source.type === "thread") acceptedInput = { ...input, source: { ...source, contentDigest } };
      else if (input.kind === "response" && source.type === "response") acceptedInput = { ...input, source: { ...source, generationId: sourceGenerationId!, contentDigest } };
      else if (input.kind === "terminal" && source.type === "native-output") acceptedInput = { ...input, source: { ...source, contentDigest } };
      acceptedSource = acceptedInput.source;
      if ("selection" in input) text = selectContextLines(text, input.selection);
      if (input.kind === "response" && input.selectedText !== undefined) {
        if (!text.includes(input.selectedText))
          throw new DurableError(409, "context_selection_changed", "The highlighted excerpt does not match the saved authorized response. Select the exact source text again.");
        text = input.selectedText;
      }
      if (input.kind === "terminal" && input.text !== undefined) {
        if (!text.includes(input.text))
          throw new DurableError(409, "context_selection_changed", "The selected terminal excerpt does not match the saved authorized command output.");
        text = input.text;
      }
      const explicitExcerpt = "selection" in input && input.selection || input.kind === "response" && input.selectedText !== undefined || input.kind === "terminal" && input.text !== undefined;
      if (nativeItemDigest && !explicitExcerpt && text.length > MAX_ITEM) { text = text.slice(0, MAX_ITEM); truncated = true; }
      dependencies = [{ threadId, messageIds: [] }, { threadId: source.threadId, messageIds: messages.map(message => message.id) },
        ...visible.flatMap(message => message.turnContext?.contextItems?.flatMap(item => item.dependencies ?? []) ?? []),
        ...(projector.visibleProvenance(messages.map(message => message.id)).contextSources ?? [])];
      const deps = mergeProvenance(projector.visibleProvenance(messages.map(message => message.id)),
        { operationIds: [], targets: pmPayloadTargets(visible) },
        ...visible.flatMap(message => message.turnContext?.contextItems?.flatMap(item => item.pmProvenance ? [item.pmProvenance] : []) ?? []));
      // Existing legacy quote text stays explicitly user-provided; it never becomes a verified original response excerpt.
      pmProvenance = { ...deps, complete: true };
    } else return unavailable("Unsupported context source.");
    if (!text.trim() && !input.comment?.trim()) return unavailable("The selected source contains no text. Add a comment or select content.");
    if (text.length > MAX_ITEM) throw new DurableError(413, "context_too_large", "Selected context exceeds 16,000 characters; select a smaller range.");
    const sources = new Map<string, Set<string>>();
    for (const dependency of dependencies ?? []) {
      let ids = sources.get(dependency.threadId);
      if (!ids) { ids = new Set(); sources.set(dependency.threadId, ids); }
      for (const messageId of dependency.messageIds) ids.add(messageId);
    }
    if (sources.size > 20) throw new DurableError(413, "context_too_large", "Context provenance exceeds 20 source Sessions; select a narrower source.");
    dependencies = [...sources].map(([threadId, ids]) => ({ threadId, messageIds: [...ids] }));
    result.push({ contextId: input.contextId, kind: input.kind, input: acceptedInput, source: acceptedSource, text, digest: contextDigest(text), inputDigest: contextDigest(acceptedInput),
      acceptedAt: acceptedAt ?? new Date().toISOString(), truncated, provenance, visibility: "available", ...(reason ? { reason } : {}), ...(label ? { label } : {}), ...(terminalLabel ? { terminalLabel } : {}), ...(dependencies ? { dependencies } : {}), ...(attachments?.length ? { attachments } : {}), ...(pmProvenance ? { pmProvenance } : {}) });
  }
  if (result.reduce((sum, item) => sum + item.text.length + (item.input?.comment?.length ?? 0), 0) > MAX_TOTAL)
    throw new DurableError(413, "context_too_large", "Selected context exceeds 48,000 characters in total; remove some items.");
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 1024 * 1024)
    throw new DurableError(413, "context_too_large", "Selected context and provenance exceed 1 MiB; select narrower sources.");
  if (result.some(item => item.attachments?.length)) await resolveContextAttachmentParts(result, headers);
  return result;
}
/** Called only on canonical, currently authorized records, after PM projection. */
export function contextPromptText(items: AcceptedChatContext[] | undefined): string {
  return (items ?? []).filter(item => item.visibility === "available").map(item =>
    `\n\n[Selected ${item.kind} context ${item.contextId}; ${item.provenance}; accepted at ${item.acceptedAt}${item.truncated ? "; source snapshot truncated" : ""}; label ${JSON.stringify(item.label)}; source ${JSON.stringify(item.source)}${item.terminalLabel ? `; terminal ${JSON.stringify(item.terminalLabel)}` : ""}${"selection" in item.input && item.input.selection ? `; selection ${JSON.stringify(item.input.selection)}` : ""}${item.input.kind === "review-comment" && item.input.diffSelection ? `; diff selection ${JSON.stringify(item.input.diffSelection)}` : ""}${item.reason ? `; ${item.reason}` : ""}${item.attachments?.length ? `; ${item.attachments.length} original file/image attachments included` : ""}]\nRead-only quoted context: do not rerun its commands or historical tasks unless the current user separately requests it.\n${item.text}${item.input.comment ? `\n\nUser comment:\n${item.input.comment}` : ""}\n[End selected context]`).join("");
}
export function projectContextMessage(message: UIMessage, items: AcceptedChatContext[] | undefined, attachments: UIMessage["parts"] = []): UIMessage {
  const text = contextPromptText(items);
  return text || attachments.length ? { ...message, parts: [...message.parts, ...(text ? [{ type: "text" as const, text }] : []), ...attachments] } : message;
}

/** Read the exact immutable file parts behind server-owned pointers, after current PM/source projection. */
export async function resolveContextAttachmentParts(items: AcceptedChatContext[] | undefined, headers: Headers): Promise<UIMessage["parts"]> {
  if (!items?.some(item => item.visibility === "available" && item.attachments?.length)) return [];
  const references = [...new Map((items ?? []).flatMap(item => item.visibility === "available" ? item.attachments ?? [] : [])
    .map(reference => [JSON.stringify(reference), reference])).values()];
  const parts: unknown[] = [];
  const sources = new Map<string, { messages: Map<string, StoredMessage>; projector: PmVisibilityProjector }>();
  for (const reference of references) {
    let source = sources.get(reference.threadId);
    if (!source) {
      await authorizeContextThread(reference.threadId, headers);
      source = { messages: new Map(getThreadHistory(reference.threadId).messages.map(message => [message.id, message])),
        projector: await createPmVisibilityProjector(reference.threadId, headers) };
      sources.set(reference.threadId, source);
    }
    const original = source.messages.get(reference.messageId);
    if (!original) return unavailable("A selected thread attachment's source message is missing.");
    const visible = source.projector.history([original])[0]!;
    if (object(visible.content.metadata) && visible.content.metadata.pmVisibility)
      throw new DurableError(403, "context_forbidden", "A selected thread attachment is no longer readable.");
    const part = Array.isArray(visible.content.parts) ? visible.content.parts[reference.partIndex] : undefined;
    if (!object(part) || part.type !== "file" || contextDigest(part) !== reference.digest)
      return unavailable("A selected thread attachment changed; select its real source again.");
    parts.push(part);
  }
  return validateChatAttachments(parts, "codex").map(payload => payload.part);
}

/** Screenshot correlation is not an upload grant: it must point to an actual wire file part. */
export function validateContextAttachmentBindings(message: UIMessage, items: ChatContextInput[] | undefined): void {
  const metadata = object(message.metadata) ? message.metadata : {};
  const custom = object(metadata.custom) ? metadata.custom : {};
  const raw = custom.contextAttachments;
  const bindings = raw === undefined ? [] : chatContextAttachmentBindingSchema.array().max(100).parse(raw);
  if (new Set(bindings.map(binding => binding.attachmentId)).size !== bindings.length ||
      new Set(bindings.map(binding => binding.partIndex)).size !== bindings.length)
    throw new DurableError(400, "invalid_context_attachment", "Attachment correlation must be one-to-one.");
  for (const binding of bindings) if (message.parts[binding.partIndex]?.type !== "file")
    throw new DurableError(400, "invalid_context_attachment", "Attachment correlation does not identify an actual file part.");
  for (const { source } of items ?? []) if (source.type === "browser" && source.attachmentId &&
      !bindings.some(binding => binding.attachmentId === source.attachmentId))
    throw new DurableError(400, "invalid_context_attachment", "The selected screenshot is missing; restore its actual attachment or remove its correlation.");
}
