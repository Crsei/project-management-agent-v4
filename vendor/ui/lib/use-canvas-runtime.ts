"use client"
import { uiMessage, uiField, type UiMessage } from "./i18n-core"

import { useI18n } from "./i18n-provider"
import { useEffect, useRef, useState } from "react"
import {
  canvasId,
  type CanvasDocument,
  type CanvasNodeDefinition,
} from "./canvas-model"
import {
  acceptCanvasRunSnapshot,
  describeCanvasRunProblem,
  canvasRuntimeUnknown,
  type CanvasRuntimeAdapter,
  type CanvasRuntimeState,
  type CanvasRunSnapshot,
  type CanvasRunScope,
  type CanvasRunRequest,
} from "./canvas-runtime"

/** Optional controller. Request acceptance never implies execution completion. */
export function useCanvasRuntime(
  document: CanvasDocument,
  definitions: CanvasNodeDefinition[],
  adapter: CanvasRuntimeAdapter,
) {
  const { resolve } = useI18n()
  const initial: CanvasRuntimeState = {
    documentId: document.id,
    transport: "connected",
  }
  const [stored, setStored] = useState(initial)
  const state = stored.documentId === document.id ? stored : initial
  const current = useRef(initial)
  const owner = useRef({ id: document.id, adapter, generation: 0 })
  const confirmation = useRef<
    ((snapshot: CanvasRunSnapshot) => boolean) | undefined
  >(undefined)
  const busy = useRef(false)
  const blocked = useRef(false)
  const startVersion = useRef<number | undefined>(undefined)
  const startRequest = useRef<string | undefined>(undefined)
  useEffect(() => {
    owner.current = {
      id: document.id,
      adapter,
      generation: owner.current.generation + 1,
    }
    busy.current = false
    blocked.current = false
    startRequest.current = undefined
    startVersion.current = undefined
    confirmation.current = undefined
    return () => {
      owner.current.generation++
    }
  }, [document.id, adapter])
  function latest() {
    return current.current.documentId === document.id
      ? current.current
      : initial
  }
  function commit(next: CanvasRuntimeState) {
    current.current = next
    setStored(next)
  }
  async function operate(
    label: UiMessage,
    read: boolean,
    action: () => Promise<CanvasRunSnapshot | null>,
    establish = false,
    confirm?: (snapshot: CanvasRunSnapshot) => boolean,
  ) {
    if (
      busy.current ||
      (!read && (blocked.current || canvasRuntimeUnknown(latest().snapshot)))
    )
      return
    const token = { ...owner.current }
    const active = () =>
      owner.current.generation === token.generation &&
      owner.current.id === token.id &&
      owner.current.adapter === token.adapter
    busy.current = true
    if (!read) confirmation.current = confirm
    commit({
      ...latest(),
      ...uiField("pending", label),
      ...uiField("readError", undefined),
    })
    try {
      const result = await action()
      if (!active()) return
      if (!result) {
        blocked.current = false
        confirmation.current = undefined
        startRequest.current = undefined
        commit({
          ...latest(),
          ...uiField("pending", undefined),
          ...uiField("uncertain", undefined),
          ...uiField("awaiting", undefined),
          ...uiField(
            "readError",
            uiMessage(
              "useCanvasRuntime.theSourceConfirmedThatThisRequestDidNot",
            ),
          ),
        })
        return
      }
      const before = latest()
      if (
        establish &&
        startVersion.current !== undefined &&
        result.documentRevision !== startVersion.current
      ) {
        blocked.current = true
        commit({
          ...before,
          ...uiField("pending", undefined),
          ...uiField(
            "uncertain",
            uiMessage(
              "useCanvasRuntime.theStartReceiptReferencesADifferentDocumentRevision",
            ),
          ),
        })
        return
      }
      const accepted = acceptCanvasRunSnapshot(before, result, establish)
      if (accepted === before) {
        if (!read) blocked.current = true
        commit({
          ...before,
          ...uiField("pending", undefined),
          ...uiField(
            "readError",
            uiMessage("useCanvasRuntime.theRunIdentityOrSequenceFromTheSource"),
          ),
          ...(!read
            ? {
                ...uiField(
                  "uncertain",
                  uiMessage(
                    "useCanvasRuntime.writeReceiptMismatchQueryForConfirmationBeforeSubmitting",
                  ),
                ),
              }
            : {}),
        })
        return
      }
      if (
        establish ||
        !before.snapshot ||
        result.sequence > before.snapshot.sequence
      ) {
        const confirmed = !confirmation.current || confirmation.current(result)
        blocked.current = canvasRuntimeUnknown(result) || !confirmed
        if (confirmed) confirmation.current = undefined
        startRequest.current = undefined
        commit(
          confirmed
            ? accepted
            : {
                ...accepted,
                uncertain: before.uncertain,
                uncertainI18n: before.uncertainI18n,
                ...uiField(
                  "awaiting",
                  uiMessage(
                    "useCanvasRuntime.theOperationRequestWasReceivedButItsFinal",
                  ),
                ),
              },
        )
      } else {
        if (!read) blocked.current = true
        commit({
          ...accepted,
          ...(!read
            ? {
                ...uiField(
                  "awaiting",
                  uiMessage(
                    "common.valueRequestSubmittedWaitingForTheSourceQuery",
                    { value0: label },
                  ),
                ),
              }
            : {}),
        })
      }
    } catch {
      if (!active()) return
      if (!read) blocked.current = true
      commit({
        ...latest(),
        ...uiField("pending", undefined),
        transport: "disconnected",
        ...(read
          ? {
              ...uiField(
                "readError",
                uiMessage(
                  "useCanvasRuntime.runReadFailedExistingStateAndOutputAre",
                ),
              ),
            }
          : {
              ...uiField(
                "uncertain",
                uiMessage(
                  "common.valueOutcomeUnknownQueryTheReceiptBeforeSubmitting",
                  { value0: label },
                ),
              ),
            }),
      })
    } finally {
      if (active()) busy.current = false
    }
  }
  function run(
    scope: CanvasRunScope = "all",
    nodeId?: string,
    inputs?: CanvasRunRequest["inputs"],
  ) {
    if (busy.current || blocked.current) return
    const problem = describeCanvasRunProblem(
      document,
      definitions,
      scope,
      nodeId,
      inputs,
    )
    if (problem || !adapter.scopes.includes(scope)) {
      commit({
        ...latest(),
        ...uiField(
          "readError",
          problem ??
            uiMessage(
              "useCanvasRuntime.theSourceDoesNotProvideThisExecutionCapability",
            ),
        ),
      })
      return
    }
    const snapshot = latest().snapshot
    if (
      snapshot &&
      !["completed", "failed", "cancelled"].includes(snapshot.status)
    )
      return
    const requestId = canvasId("run-request")
    return operate(
      uiMessage("useCanvasRuntime.startRun"),
      false,
      () => {
        startRequest.current = requestId
        startVersion.current = document.revision
        return adapter.run({
          requestId,
          document: structuredClone(document),
          scope,
          nodeId,
          inputs,
        })
      },
      true,
    )
  }
  function query() {
    if (startRequest.current && adapter.reconcileStart)
      return operate(
        uiMessage("useCanvasRuntime.queryStartReceipt"),
        true,
        () => adapter.reconcileStart!(startRequest.current!),
        true,
      )
    const snapshot = latest().snapshot
    if (snapshot)
      return operate(uiMessage("canvasExecutionPanel.queryRun"), true, () =>
        adapter.query(snapshot.runId),
      )
  }
  function stop() {
    const snapshot = latest().snapshot
    if (
      !snapshot ||
      !adapter.stop ||
      ["completed", "failed", "cancelled"].includes(snapshot.status)
    )
      return
    const requestId = canvasId("stop")
    return operate(
      uiMessage("chatMessage.stop"),
      false,
      () => adapter.stop!({ runId: snapshot.runId, requestId }),
      false,
      (result) =>
        ["confirmed", "rejected"].includes(
          result.requests?.[requestId] ?? "",
        ) ||
        (!canvasRuntimeUnknown(result) &&
          ["completed", "failed", "cancelled"].includes(result.status)),
    )
  }
  function decide(nodeId: string, decision: "approve" | "reject") {
    const snapshot = latest().snapshot,
      node = snapshot?.nodes[nodeId]
    if (
      !snapshot ||
      !node?.approval ||
      node.status !== "waiting" ||
      node.outcome === "unknown" ||
      !adapter.decide
    )
      return
    const requestId = canvasId("approval")
    return operate(
      decision === "approve"
        ? uiMessage("toolCall.approve")
        : uiMessage("toolCall.reject"),
      false,
      () =>
        adapter.decide!({
          runId: snapshot.runId,
          nodeId,
          attemptId: node.attemptId,
          approvalId: node.approval!.id,
          decision,
          requestId,
        }),
      false,
      (result) =>
        ["confirmed", "rejected"].includes(
          result.requests?.[requestId] ?? "",
        ) ||
        (result.nodes[nodeId]?.attemptId === node.attemptId &&
          result.nodes[nodeId]?.status !== "waiting" &&
          !result.nodes[nodeId]?.approval &&
          !canvasRuntimeUnknown(result)),
    )
  }
  function receive(snapshot: CanvasRunSnapshot) {
    const before = latest(),
      accepted = acceptCanvasRunSnapshot(before, snapshot)
    if (accepted === before) return
    const confirmed = !confirmation.current || confirmation.current(snapshot)
    if (snapshot.sequence > (before.snapshot?.sequence ?? -1)) {
      blocked.current = canvasRuntimeUnknown(snapshot) || !confirmed
      if (confirmed) confirmation.current = undefined
    }
    commit(
      confirmed
        ? accepted
        : {
            ...accepted,
            uncertain: before.uncertain,
            uncertainI18n: before.uncertainI18n,
            awaiting: before.awaiting,
            awaitingI18n: before.awaitingI18n,
          },
    )
  }
  return {
    state: {
      ...state,
      pending:
        state.pending === undefined
          ? undefined
          : resolve(state.pendingI18n, state.pending),
      readError:
        state.readError === undefined
          ? undefined
          : resolve(state.readErrorI18n, state.readError),
      uncertain:
        state.uncertain === undefined
          ? undefined
          : resolve(state.uncertainI18n, state.uncertain),
      awaiting:
        state.awaiting === undefined
          ? undefined
          : resolve(state.awaitingI18n, state.awaiting),
    },
    adapter,
    run,
    query,
    stop,
    decide,
    receive,
  }
}
export type CanvasRuntimeController = ReturnType<typeof useCanvasRuntime>
