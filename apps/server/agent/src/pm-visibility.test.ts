import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pmToolCallProjectionSchema, type PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
import { closeStore, writeRecord } from "./durable/store.ts";
import type { StoredMessage } from "./durable/threads.ts";
import { createPmVisibilityProjector, recordPmContentProvenance, recordPmQuoteProvenance } from "./pm-visibility.ts";
import type { StoredPmToolCall } from "./pm-tools.ts";

test("five-target history projects each call and nested dependency independently without sensitive raw JSON", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-visibility-"));
  const oldData = process.env.AGENT_WORKSPACE_DATA_DIR, oldUrl = process.env.PM_API_URL;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  const actorId = randomUUID(), workspaceId = randomUUID(), threadId = "mixed-history";
  const denied = new Set<string>(); let unavailable = false, actor = actorId;
  const authorizationTargets: string[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/api/v1/agent-contexts/authorize");
    let text = ""; for await (const chunk of req) text += String(chunk);
    const target = JSON.parse(text) as { workspaceId: string; projectId: string | null };
    authorizationTargets.push(target.workspaceId);
    res.setHeader("content-type", "application/json");
    if (unavailable) { res.writeHead(503).end(JSON.stringify({ error: "private infrastructure exception" })); return; }
    if (target.workspaceId !== workspaceId || denied.has(target.projectId ?? "workspace")) { res.writeHead(403).end(JSON.stringify({ error: "private denied title" })); return; }
    res.end(JSON.stringify({ actorId: actor, scope: target }));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string"); process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  const records: PmToolCallRecord[] = [], messages: StoredMessage[] = [];
  try {
    for (let index = 1; index <= 5; index++) {
      const projectId = `PRJ-00${index}`, generationId = randomUUID(), operationId = randomUUID(), messageId = `assistant-${index}`;
      const source = { workspaceId, projectId, kind: "task" as const, entityId: `TASK-00${index}`, title: `private-title-${index}`, revision: "rev", truncated: false };
      const record: PmToolCallRecord = { operationId, threadId, messageId, generationId, actorId, workspaceId, target: { workspaceId, projectId },
        name: "pm_update_task", status: "succeeded", createdAt: "2026-11-10T00:00:00.000Z", finishedAt: "2026-11-10T00:00:01.000Z",
        error: { code: `private-error-${index}`, message: `private-exception-${index}` }, arguments: { body: `private-argument-${index}` },
        result: { kind: "task", items: [{ id: source.entityId, entity: "work_item", title: source.title, projectId, revision: "rev", version: 1, status: "todo", body: `private-body-${index}` }], sources: [source], nextCursor: null, truncated: false,
          receipt: { kind: "core", operationId, commandId: `private-receipt-${index}`, action: "UpdateTask", targetId: source.entityId, revision: "rev" } },
        changeSet: { id: operationId, kind: "update", state: "applied", targetId: source.entityId, targetTitle: source.title, projectId, summary: `private-summary-${index}`, receiptId: operationId, commandId: null, error: null,
          fields: [{ field: "body", label: "Body", before: `private-before-${index}`, after: `private-after-${index}` }], createdAt: "2026-11-10T00:00:00.000Z" } };
      records.push(record);
      const request = { operationId, name: record.name, target: record.target, arguments: record.arguments, threadId, messageId, generationId };
      writeRecord<StoredPmToolCall>("pm-tool-calls", operationId, { record, request });
      writeRecord("chat:generations", generationId, { id: generationId, threadId, messageId, pmReferences: [source], request: { system: `private-system-${index}`, transferContext: `private-transfer-${index}` }, output: { text: `private-model-${index}` } });
      recordPmContentProvenance({ threadId, generationId, messageIds: [messageId], operationIds: [operationId], targets: [record.target!] });
      messages.push({ id: messageId, parent_id: index === 1 ? null : `assistant-${index - 1}`, format: "ai-sdk/v6", content: { role: "assistant", parts: [{ type: "text", text: `private-model-${index}` }] } });
    }
    denied.add("PRJ-003");
    let projector = await createPmVisibilityProjector(threadId, new Headers());
    assert.equal(projector.calls.filter(call => call.visibility === "visible").length, 4);
    for (const call of projector.calls) pmToolCallProjectionSchema.parse(call);
    const hidden = projector.calls.find(call => call.operationId === records[2]!.operationId)!;
    assert.deepEqual(Object.keys(hidden).sort(), ["generationId", "messageId", "operationId", "threadId", "visibility"]);
    const history = projector.history(messages);
    assert.equal(history.filter(message => JSON.stringify(message).includes("private-model-")).length, 4);
    const forbiddenMarkers = /private-(?:title|body|argument|error|exception|receipt|summary|before|after|model|system|transfer)-3|PRJ-003|TASK-003/;
    assert.doesNotMatch(JSON.stringify({ calls: projector.calls, history }), forbiddenMarkers);
    assert.equal(projector.nativeContextContaminated, true);
    assert.equal(projector.visibleProvenance([messages[0]!.id, messages[2]!.id]).operationIds.length, 1);
    const generation = { id: records[2]!.generationId, messageId: records[2]!.messageId, error: "private-exception-3", pmReferences: records[2]!.result!.sources, request: { system: "private-system-3" } };
    assert.doesNotMatch(JSON.stringify(projector.generation(generation)), forbiddenMarkers);
    const snapshot = { generationId: records[2]!.generationId, threadId, sequence: 10, status: "completed" as const,
      items: [{ id: `pm-tool:${records[2]!.operationId}`, type: "dynamic_tool" as const, status: "completed" as const, input: "private-argument-3", output: JSON.stringify(records[2]), error: "private-exception-3" }] };
    assert.doesNotMatch(JSON.stringify(projector.nativeSnapshot(snapshot)), forbiddenMarkers);
    assert.doesNotMatch(JSON.stringify(projector.nativeFrame({ kind: "snapshot", snapshot })), forbiddenMarkers);
    assert.doesNotMatch(JSON.stringify(projector.uiChunk({ type: "tool-output-available", toolCallId: records[2]!.operationId, output: records[2] }, records[2]!.generationId)), forbiddenMarkers);
    const hiddenDelta = projector.uiChunk({ type: "text-delta", id: "part", delta: "private-body-3", providerMetadata: { pm: { detail: "private-body-3" } } }, records[2]!.generationId);
    assert.equal(hiddenDelta.type, "text-delta");
    assert.doesNotMatch(JSON.stringify(hiddenDelta), forbiddenMarkers);
    assert.ok(!("providerMetadata" in hiddenDelta));
    assert.deepEqual(projector.uiChunk({ type: "text-start", id: "part", providerMetadata: { pm: { detail: "private-body-3" } } }, records[2]!.generationId), { type: "text-start", id: "part" });
    const mixedNativeGeneration = randomUUID(), mixedNativeMessageId = "mixed-native-assistant";
    const nativeCalls = records.slice(0, 3).map(original => {
      const operationId = randomUUID();
      const record: PmToolCallRecord = { ...original, operationId, generationId: mixedNativeGeneration, messageId: mixedNativeMessageId,
        result: original.result ? { ...original.result, ...(original.result.receipt ? { receipt: { ...original.result.receipt, operationId } } : {}) } : null,
        changeSet: original.changeSet ? { ...original.changeSet, id: operationId } : undefined };
      writeRecord<StoredPmToolCall>("pm-tool-calls", operationId, { record, request: {
        operationId, name: record.name, target: record.target, arguments: record.arguments, threadId, messageId: mixedNativeMessageId, generationId: mixedNativeGeneration,
      } });
      return record;
    });
    writeRecord("chat:generations", mixedNativeGeneration, { id: mixedNativeGeneration, threadId, messageId: mixedNativeMessageId,
      pmOperations: nativeCalls.map(record => ({ actorId, target: record.target! })) });
    recordPmContentProvenance({ threadId, generationId: mixedNativeGeneration, messageIds: [mixedNativeMessageId],
      operationIds: nativeCalls.map(record => record.operationId), targets: nativeCalls.map(record => record.target!) });
    const mixedNativeOutput = { generationId: mixedNativeGeneration, threadId, sequence: 7, status: "completed" as const, items: [
      ...nativeCalls.map(record => ({ id: `pm-tool:${record.operationId}`, type: "dynamic_tool" as const, status: "completed" as const, output: JSON.stringify(record) })),
      { id: "provider-prose", type: "assistant_message" as const, status: "completed" as const, text: "private-native-prose" },
    ] };
    writeRecord("native-output", mixedNativeGeneration, mixedNativeOutput);
    const forgedMetadata = { durable: { generationId: "forged-route", nativeOutput: true, error: "private-provider-metadata" },
      custom: { durable: { generationId: "forged-custom-route", nativeOutput: true }, provider: "private-provider-metadata" } };
    const mixedNativeMessage: StoredMessage = { id: mixedNativeMessageId, parent_id: null, format: "ai-sdk/v6",
      content: { role: "assistant", parts: [{ type: "text", text: "private-native-prose" }], metadata: forgedMetadata } };
    projector = await createPmVisibilityProjector(threadId, new Headers());
    const expectedRoutingMetadata = { pmVisibility: "redacted", durable: { generationId: mixedNativeGeneration, nativeOutput: true } };
    const nativeHistory = projector.history([mixedNativeMessage])[0]!;
    assert.deepEqual(nativeHistory.content.metadata, expectedRoutingMetadata,
      "a hidden assistant keeps only server-proven routing so authorized per-item native cards remain reachable");
    assert.doesNotMatch(JSON.stringify(nativeHistory), /private-native-prose|private-provider-metadata|forged/);
    const reachableOutput = projector.nativeSnapshot(mixedNativeOutput);
    assert.equal(reachableOutput.items.filter(item => item.type === "dynamic_tool" && item.visibility === "visible").length, 2);
    assert.match(JSON.stringify(reachableOutput), /private-body-1/);
    assert.match(JSON.stringify(reachableOutput), /private-body-2/);
    assert.doesNotMatch(JSON.stringify(reachableOutput), /private-body-3|private-native-prose/);
    for (const frame of [
      { type: "start" as const, messageId: "forged-message", messageMetadata: forgedMetadata },
      { type: "message-metadata" as const, messageMetadata: forgedMetadata },
      { type: "finish" as const, messageMetadata: forgedMetadata },
    ]) {
      const projectedFrame = projector.uiChunk(frame, mixedNativeGeneration);
      assert.ok("messageMetadata" in projectedFrame);
      assert.deepEqual(projectedFrame.messageMetadata, expectedRoutingMetadata);
      assert.doesNotMatch(JSON.stringify(projectedFrame), /private-provider-metadata|forged/);
    }
    assert.doesNotMatch(JSON.stringify(projector.generation({ id: mixedNativeGeneration,
      output: { text: "private-native-prose" }, request: { transferContext: "private-native-prose" } })), /private-native-prose/);
    const nonNativeGeneration = randomUUID(), nonNativeMessageId = "non-native-hidden-assistant";
    writeRecord("chat:generations", nonNativeGeneration, { id: nonNativeGeneration, threadId, messageId: nonNativeMessageId });
    recordPmContentProvenance({ threadId, generationId: nonNativeGeneration, messageIds: [nonNativeMessageId], operationIds: [], targets: [records[2]!.target!] });
    const nonNativeMessage: StoredMessage = { id: nonNativeMessageId, parent_id: null, format: "ai-sdk/v6",
      content: { role: "assistant", parts: [{ type: "text", text: "private-native-prose" }],
        metadata: { durable: { generationId: mixedNativeGeneration, nativeOutput: true } } } };
    projector = await createPmVisibilityProjector(threadId, new Headers());
    assert.deepEqual(projector.history([nonNativeMessage])[0]!.content.metadata, { pmVisibility: "redacted" },
      "client routing cannot borrow another assistant's valid output snapshot");
    writeRecord("native-output", nonNativeGeneration, { ...mixedNativeOutput, generationId: nonNativeGeneration, threadId: "other-session" });
    assert.deepEqual(projector.history([nonNativeMessage])[0]!.content.metadata, { pmVisibility: "redacted" });
    writeRecord("native-output", nonNativeGeneration, { ...mixedNativeOutput, generationId: mixedNativeGeneration });
    assert.deepEqual(projector.history([nonNativeMessage])[0]!.content.metadata, { pmVisibility: "redacted" });
    const nonNativeFrame = projector.uiChunk({ type: "message-metadata", messageMetadata: forgedMetadata }, nonNativeGeneration);
    assert.ok("messageMetadata" in nonNativeFrame);
    assert.deepEqual(nonNativeFrame.messageMetadata, { pmVisibility: "redacted" });
    assert.doesNotMatch(JSON.stringify(projector.commandFrame({ kind: "append", text: "private-body-3", truncated: false, running: true }, records[2]!.generationId, "command")), forbiddenMarkers);
    const mixed = { ...records[0]!, operationId: randomUUID(), result: { ...records[0]!.result!, sources: [records[0]!.result!.sources[0]!, records[2]!.result!.sources[0]!] } } as PmToolCallRecord;
    writeRecord("pm-tool-calls", mixed.operationId, { record: mixed, request: { operationId: mixed.operationId, name: mixed.name, target: mixed.target, arguments: { nested: JSON.stringify({ workspaceId, projectId: "PRJ-003", body: "private-body-3" }) }, threadId, messageId: mixed.messageId, generationId: mixed.generationId } });
    projector = await createPmVisibilityProjector(threadId, new Headers());
    assert.equal(projector.calls.find(call => call.operationId === mixed.operationId)!.visibility, "redacted", "a real secondary PM source remains an enforced read dependency");
    const exampleScope = { workspaceId: randomUUID(), projectId: null };
    const exampleJson = JSON.stringify(exampleScope);
    const exampleArguments = { body: exampleJson, example: exampleScope };
    const exampleRecord: PmToolCallRecord = { ...records[0]!, operationId: randomUUID(), arguments: exampleArguments,
      result: { kind: "task", items: [{ id: "TASK-001", entity: "work_item", projectId: "PRJ-001", title: "JSON documentation example", revision: "rev", version: 1, status: "todo", body: exampleJson }],
        sources: records[0]!.result!.sources, nextCursor: null, truncated: false } };
    writeRecord("pm-tool-calls", exampleRecord.operationId, { record: exampleRecord, request: {
      operationId: exampleRecord.operationId, name: exampleRecord.name, target: exampleRecord.target, arguments: exampleArguments,
      threadId, messageId: exampleRecord.messageId, generationId: exampleRecord.generationId,
    } });
    const exampleProjector = await createPmVisibilityProjector(threadId, new Headers(), { operationIds: [exampleRecord.operationId] });
    const exampleCall = exampleProjector.calls[0]!;
    assert.ok(exampleCall.visibility === "visible");
    assert.ok(exampleCall.result?.kind === "task");
    assert.equal(exampleCall.result.items[0]!.body, exampleJson, "readable body JSON is prose, not an additional permission requirement");
    assert.deepEqual(exampleCall.arguments, exampleArguments);
    assert.ok(!authorizationTargets.includes(exampleScope.workspaceId), "user-authored JSON cannot trigger an unrelated authorization query");
    const exampleUser: StoredMessage = { id: "json-example-user", parent_id: null, format: "ai-sdk/v6",
      content: { role: "user", parts: [{ type: "text", text: exampleJson }] } };
    assert.equal((exampleProjector.history([exampleUser])[0]!.content.parts as { text: string }[])[0]!.text, exampleJson);
    const unboundRecord = { ...records[0]!, operationId: randomUUID() };
    const unbound = exampleProjector.nativeSnapshot({ generationId: records[0]!.generationId, threadId, sequence: 11, status: "completed",
      items: [{ id: "unbound-provider-pm-copy", type: "dynamic_tool", status: "completed", toolName: "pm_update_task", output: JSON.stringify({ structuredContent: unboundRecord }) }] }).items[0]!;
    assert.equal(unbound.visibility, "unavailable");
    assert.doesNotMatch(JSON.stringify(unbound), /private-body-1/);
    assert.doesNotMatch(JSON.stringify(exampleProjector.uiChunk({ type: "tool-output-available", toolCallId: "unbound-call", output: JSON.stringify(unboundRecord) }, records[0]!.generationId)), /private-body-1/,
      "recognized PM envelopes without an original durable operation fail closed rather than trusting their self-declared scopes");
    const user: StoredMessage = { id: "user", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "my input" }], metadata: { custom: { turnContext: { unsafe: "private-body-3" } } } },
      turnContext: { version: 1, threadId, messageId: "user", acceptedAt: "2026-11-10T00:00:00.000Z", pmReferences: [records[0]!.result!.sources[0]!, records[2]!.result!.sources[0]!].map(source => ({
        workspaceId: source.workspaceId, projectId: source.projectId, kind: "issue", id: source.entityId, title: source.title, revision: source.revision, availability: "available", reason: null,
      })) } };
    const userProjection = projector.history([user])[0]!;
    assert.doesNotMatch(JSON.stringify(userProjection), forbiddenMarkers);
    assert.match(JSON.stringify(userProjection), /PRJ-001/);
    unavailable = true;
    projector = await createPmVisibilityProjector(threadId, new Headers());
    assert.ok(projector.calls.every(call => call.visibility === "unavailable"));
    assert.doesNotMatch(JSON.stringify(projector.calls), /private-/);
    unavailable = false; denied.clear(); actor = randomUUID();
    projector = await createPmVisibilityProjector(threadId, new Headers());
    assert.ok(projector.calls.every(call => call.visibility === "redacted"), "same project authority is not another actor's receipt authority");
    writeRecord("pm-content-provenance", records[0]!.generationId, { threadId, generationId: records[0]!.generationId,
      messageIds: [messages[0]!.id], operationIds: [], targets: [records[0]!.target!] });
    projector = await createPmVisibilityProjector(threadId, new Headers());
    assert.doesNotMatch(JSON.stringify(projector.history([messages[0]!])), /private-model-1/,
      "target-only saved provenance must still combine the generation's own original-actor call");
    const referenceGeneration = randomUUID(), referenceMessageId = "reference-only-assistant";
    const originalAuthority = { actorId, target: records[0]!.target! };
    writeRecord("chat:generations", referenceGeneration, { id: referenceGeneration, threadId, messageId: referenceMessageId, pmOperations: [originalAuthority] });
    recordPmContentProvenance({ threadId, generationId: referenceGeneration, messageIds: [referenceMessageId], operationIds: [], targets: [originalAuthority.target] });
    const referenceSource: StoredMessage = { id: referenceMessageId, parent_id: null, format: "ai-sdk/v6",
      content: { role: "assistant", parts: [{ type: "text", text: "private-reference-only" }] } };
    const referenceQuote: StoredMessage = { id: "reference-quote", parent_id: referenceMessageId, format: "ai-sdk/v6",
      content: { role: "user", parts: [{ type: "text", text: "keep-user-question" }], metadata: { custom: { quote: { messageId: referenceMessageId, text: "private-reference-only" } } } } };
    const chainedQuote: StoredMessage = { id: "chained-reference-quote", parent_id: referenceQuote.id, format: "ai-sdk/v6",
      content: { role: "user", parts: [{ type: "text", text: "keep-chained-question" }], metadata: { custom: { quote: { messageId: referenceQuote.id, text: "private-reference-only" } } } } };
    writeRecord("chat:history", "actor-reference-quotes", { threadId, messages: [referenceSource, referenceQuote, chainedQuote] });
    recordPmQuoteProvenance({ threadId, messageId: referenceQuote.id, sourceMessageId: referenceSource.id });
    recordPmQuoteProvenance({ threadId, messageId: chainedQuote.id, sourceMessageId: referenceQuote.id });
    projector = await createPmVisibilityProjector(threadId, new Headers());
    const referenceHistory = projector.history([referenceSource, referenceQuote, chainedQuote]);
    assert.doesNotMatch(JSON.stringify(referenceHistory), /private-reference-only/);
    assert.match(JSON.stringify(referenceHistory), /keep-user-question/); assert.match(JSON.stringify(referenceHistory), /keep-chained-question/);
    const authorityFork = "reference-authority-fork";
    recordPmContentProvenance({ threadId: authorityFork, generationId: "reference-fork-generation", messageIds: ["reference-fork-summary"],
      operationIds: [], targets: [originalAuthority.target], authorities: [originalAuthority] });
    const authorityForkProjection = await createPmVisibilityProjector(authorityFork, new Headers());
    assert.equal(authorityForkProjection.nativeContextContaminated, true);
    assert.doesNotMatch(JSON.stringify(authorityForkProjection.history([{ id: "reference-fork-summary", parent_id: null, format: "ai-sdk/v6",
      content: { role: "user", parts: [{ type: "text", text: "private-reference-only" }] } }])), /private-reference-only/);
    actor = actorId; denied.add("workspace");
    const projectRecord: PmToolCallRecord = { ...records[0]!, operationId: randomUUID(), name: "pm_read", result: {
      kind: "project", items: [{ id: "PRJ-001", entity: "project", projectId: null, title: "Visible project", revision: "rev", version: 1, status: null }],
      sources: [{ workspaceId, projectId: null, kind: "project", entityId: "PRJ-001", title: "Visible project", revision: "rev", truncated: false }], nextCursor: null, truncated: false,
    }, changeSet: undefined };
    writeRecord("pm-tool-calls", projectRecord.operationId, { record: projectRecord, request: {
      operationId: projectRecord.operationId, name: projectRecord.name, target: projectRecord.target, arguments: { projectId: null },
      threadId, messageId: projectRecord.messageId, generationId: projectRecord.generationId,
    } });
    projector = await createPmVisibilityProjector(threadId, new Headers(), { operationIds: [projectRecord.operationId] });
    assert.equal(projector.calls[0]!.visibility, "visible", "a project entity's null parent does not require workspace authority");
    const legacy = { ...records[0]!, operationId: randomUUID(), actorId: undefined };
    writeRecord("pm-tool-calls", legacy.operationId, { record: legacy, request: { operationId: legacy.operationId, name: legacy.name, target: legacy.target, arguments: {}, threadId, messageId: legacy.messageId, generationId: legacy.generationId } });
    projector = await createPmVisibilityProjector(threadId, new Headers(), { operationIds: [legacy.operationId] });
    assert.equal(projector.calls[0]!.visibility, "unavailable", "legacy missing actor is never inferred from the reader");
    const proven = { ...records[0]!, result: null, error: null, certainty: { dispatch: "possibly_sent", evidence: "internal_proof" }, commandIds: ["a".repeat(64)] };
    writeRecord("pm-tool-calls", proven.operationId, { record: proven, request: { operationId: proven.operationId, name: proven.name, target: proven.target, arguments: {}, threadId, messageId: proven.messageId, generationId: proven.generationId } });
    projector = await createPmVisibilityProjector(threadId, new Headers(), { operationIds: [proven.operationId] });
    const duplicate = projector.nativeSnapshot({ generationId: proven.generationId, threadId, status: "cancelled", sequence: 20, items: [
      { id: "provider-copy", type: "dynamic_tool", status: "failed", error: "stale-private-error", input: "stale-private-input", output: JSON.stringify({ isError: true, structuredContent: { ...records[0]!, status: "unknown" } }) },
    ] }).items[0]!;
    assert.equal(duplicate.status, "completed"); assert.doesNotMatch(JSON.stringify(duplicate), /stale-private|private-body-1/);
    assert.equal((JSON.parse(duplicate.output!) as PmToolCallRecord).certainty?.evidence, "internal_proof");
    const forkThread = "fork-history", forkGeneration = randomUUID();
    recordPmContentProvenance({ threadId: forkThread, generationId: forkGeneration, messageIds: ["fork-summary"], operationIds: [proven.operationId], targets: [proven.target!] });
    actor = randomUUID();
    const forkProjection = await createPmVisibilityProjector(forkThread, new Headers());
    assert.equal(forkProjection.calls.length, 0, "cross-thread dependencies never enumerate source calls");
    assert.equal(forkProjection.nativeContextContaminated, true);
    assert.doesNotMatch(JSON.stringify(forkProjection.history([{ id: "fork-summary", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "private-model-1" }] } }])), /private-model-1/);
    actor = actorId;
    const quotedUser: StoredMessage = { id: "quoted-user", parent_id: messages[0]!.id, format: "ai-sdk/v6", content: {
      role: "user", parts: [{ type: "text", text: "my unrelated follow-up" }], metadata: { custom: { quote: { text: "private-model-1", messageId: messages[0]!.id } } },
    } };
    writeRecord("chat:history", "quote-fixture", { threadId, messages: [...messages, quotedUser] });
    recordPmQuoteProvenance({ threadId, messageId: quotedUser.id, sourceMessageId: messages[0]!.id });
    assert.throws(() => recordPmQuoteProvenance({ threadId, messageId: quotedUser.id, sourceMessageId: messages[1]!.id }), /another source/);
    denied.add("PRJ-001");
    projector = await createPmVisibilityProjector(threadId, new Headers());
    const filteredQuote = projector.history([quotedUser])[0]!;
    assert.match(JSON.stringify(filteredQuote), /my unrelated follow-up/);
    assert.doesNotMatch(JSON.stringify(filteredQuote), /private-model-1/);
  } finally {
    server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise; closeStore();
    if (oldData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldData;
    if (oldUrl === undefined) delete process.env.PM_API_URL; else process.env.PM_API_URL = oldUrl;
    await rm(directory, { recursive: true, force: true });
  }
});
