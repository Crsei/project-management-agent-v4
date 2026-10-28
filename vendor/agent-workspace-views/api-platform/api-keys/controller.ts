import type { DataTableSort } from "@easyuse-ui/ui/components/blocks/data-table"
import type { DataTableColumnConfig } from "@easyuse-ui/ui/lib/data-table-model"
import { dataTableQueryKey } from "@easyuse-ui/ui/lib/data-table-model"
import {
  apAsOf,
  apScope,
  type ApOperationResult,
  type ApScenario,
} from "../model.ts"
import type { ApAccountData, ApAccountRole } from "../fixtures/accounts"
import {
  apKeyCreateFixtureOutcome,
  apKeyCreateReceipt,
  apKeyCreateSecret,
  apKeyDefaultExpirationDays,
  apKeyNextId,
  apKeyPermissionForRole,
  apKeyRevokeFixtureOutcome,
  apKeyRevokeReceipt,
  apKeySecretMask,
  apKeyStatusOf,
  createApApiKeys,
  type ApApiKey,
  type ApKeyCreateRequest,
  type ApKeyPermission,
  type ApKeyStatus,
} from "./fixtures.ts"

export type ApKeyDraft = {
  name: string
  /** Empty selects the signed-in profile member in the view. */
  ownerMemberId: string
  projectId: string
  permission: ApKeyPermission
  expirationDays: number
}
export type ApKeyCreateState = {
  open: boolean
  phase: "form" | "created"
  draft: ApKeyDraft
  error: "too-short" | "too-long" | null
  status: ApOperationResult
  intent: "create" | "check" | null
  operationId: string | null
  receiptChecked: boolean
  requestVersion: string | null
  /** Frozen original request; it never changes while the outcome is unknown. */
  request: ApKeyCreateRequest | null
  createdKeyId: string | null
  attempt: number
}
export type ApKeyRevokeState = {
  open: boolean
  /** Frozen revocable targets chosen when the dialog opened. */
  targetIds: string[]
  skippedIds: string[]
  status: ApOperationResult
  intent: "revoke" | "check" | null
  operationId: string | null
  receiptChecked: boolean
  requestVersion: string | null
  request: { targetIds: string[] } | null
  attempt: number
}
export type ApKeysState = {
  canWrite: boolean
  keys: ApApiKey[]
  search: string
  searchOpen: boolean
  status: "all" | ApKeyStatus
  project: string
  sort: DataTableSort
  page: number
  pageSize: number
  columns: DataTableColumnConfig
  selectedIds: string[]
  detailKeyId: string | null
  create: ApKeyCreateState
  revoke: ApKeyRevokeState
  recovered: boolean
  notice: "idle" | "copied" | "copy-error" | "exported"
}
export type ApKeyRow = ApApiKey & {
  status: ApKeyStatus
  ownerName: string | null
  projectName: string | null
  role: ApAccountRole | null
  permission: ApKeyPermission | null
}

export function createApKeysState(
  scenario: ApScenario,
  defaults: { ownerMemberId: string; projectId: string },
): ApKeysState {
  return {
    canWrite: scenario !== "readonly",
    keys: createApApiKeys(scenario),
    search: "",
    searchOpen: false,
    status: "all",
    project: "all",
    sort: { columnId: "spend", direction: "desc" },
    page: 1,
    pageSize: 10,
    columns: {},
    selectedIds: [],
    detailKeyId: null,
    create: {
      open: false,
      phase: "form",
      draft: {
        name: "",
        ownerMemberId: defaults.ownerMemberId,
        projectId: defaults.projectId,
        permission: "restricted",
        expirationDays: apKeyDefaultExpirationDays,
      },
      error: null,
      status: "idle",
      intent: null,
      operationId: null,
      receiptChecked: false,
      requestVersion: null,
      request: null,
      createdKeyId: null,
      attempt: 0,
    },
    revoke: {
      open: false,
      targetIds: [],
      skippedIds: [],
      status: "idle",
      intent: null,
      operationId: null,
      receiptChecked: false,
      requestVersion: null,
      request: null,
      attempt: 0,
    },
    recovered: false,
    notice: "idle",
  }
}

/** Owner, project and role resolve through the shared account fixture. */
export function apKeyRows(
  state: ApKeysState,
  account: ApAccountData,
): ApKeyRow[] {
  return state.keys.map((key) => {
    const owner = account.members.find((m) => m.memberId === key.ownerMemberId)
    const project = account.projects.find((p) => p.projectId === key.projectId)
    const role = account.roles.find((r) => r.roleId === key.roleId) ?? null
    return {
      ...key,
      status: apKeyStatusOf(key),
      ownerName: owner?.name ?? null,
      projectName: project?.name ?? null,
      role,
      permission: role ? apKeyPermissionForRole(role.roleId) : null,
    }
  })
}
export function filterApKeyRows(
  state: ApKeysState,
  rows: readonly ApKeyRow[],
): ApKeyRow[] {
  const search = state.search.trim().toLowerCase()
  return rows.filter(
    (row) =>
      (state.status === "all" || row.status === state.status) &&
      (state.project === "all" || row.projectId === state.project) &&
      (!search ||
        `${row.name} ${row.ownerName ?? ""} ${row.keyId}`
          .toLowerCase()
          .includes(search)),
  )
}
/** Unknown spend never ranks: it stays after every known amount. */
export function sortApKeyRows(
  state: ApKeysState,
  rows: readonly ApKeyRow[],
): ApKeyRow[] {
  const sort = state.sort
  if (!sort) return [...rows]
  const direction = sort.direction === "asc" ? 1 : -1
  return [...rows].sort((a, b) => {
    if (sort.columnId === "name")
      return a.name.localeCompare(b.name) * direction
    const av = a.spendMicroUsd,
      bv = b.spendMicroUsd
    if (av === null && bv === null) return a.keyId.localeCompare(b.keyId)
    if (av === null) return 1
    if (bv === null) return -1
    return av === bv ? a.keyId.localeCompare(b.keyId) : (av - bv) * direction
  })
}
export function apKeyPage(state: ApKeysState, rows: readonly ApKeyRow[]) {
  const total = rows.length,
    pageCount = Math.max(1, Math.ceil(total / state.pageSize)),
    page = Math.min(state.page, pageCount),
    start = (page - 1) * state.pageSize
  return {
    total,
    page,
    pageCount,
    start,
    end: Math.min(start + state.pageSize, total),
    visible: rows.slice(start, start + state.pageSize),
  }
}
export function updateApKeyFilter<K extends "search" | "status" | "project">(
  state: ApKeysState,
  key: K,
  value: ApKeysState[K],
): ApKeysState {
  // Filtering never touches the selection, so it cannot broaden a revoke target.
  return { ...state, [key]: value, page: 1 }
}
export function setApKeySelection(
  state: ApKeysState,
  ids: readonly string[],
): ApKeysState {
  const known = new Set(state.keys.map((key) => key.keyId))
  return { ...state, selectedIds: ids.filter((id) => known.has(id)) }
}
export function selectApKeyFiltered(
  state: ApKeysState,
  rows: readonly ApKeyRow[],
): ApKeysState {
  const ids = new Set(state.selectedIds)
  for (const row of rows) ids.add(row.keyId)
  return { ...state, selectedIds: [...ids] }
}

/** Table scroll identity: one slot per full filter/sort/page query. */
export function apKeyQueryKey(state: ApKeysState): string {
  return dataTableQueryKey({
    scope: `${apScope.orgId}:${apScope.projectId}`,
    filter: JSON.stringify([state.search, state.status, state.project]),
    sort: state.sort,
    page: state.page,
    pageSize: state.pageSize,
  })
}
/** Exports the complete filtered set: metadata and masks, never secrets. */
export function apKeyExport(rows: readonly ApKeyRow[]): string {
  return JSON.stringify(
    {
      source: "local-fixture",
      asOf: "2026-10-12T00:00:00Z",
      currency: "USD",
      keys: rows.map((row) => ({
        keyId: row.keyId,
        name: row.name,
        owner: row.ownerName,
        ownerKnown: row.ownerName !== null,
        project: row.projectName,
        status: row.status,
        permission: row.permission,
        secretMask: row.secretMask,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        lastUsedAt: row.lastUsedAt,
        spendMicroUsd: row.spendMicroUsd,
      })),
    },
    null,
    2,
  )
}

export function openApKeyDetail(
  state: ApKeysState,
  keyId: string,
): ApKeysState {
  return { ...state, detailKeyId: keyId, notice: "idle" }
}
export function closeApKeyDetail(state: ApKeysState): ApKeysState {
  return { ...state, detailKeyId: null }
}
export function openApKeyCreate(state: ApKeysState): ApKeysState {
  if (state.create.status === "pending") return state
  const create = state.create,
    settled = create.status === "confirmed"
  return {
    ...state,
    create: {
      ...create,
      open: true,
      error: null,
      // A finished creation starts a new form; rejected/unknown keep their
      // draft, error and locked request until resolved.
      status: settled ? "idle" : create.status,
      phase: settled ? "form" : create.phase,
      createdKeyId: settled ? null : create.createdKeyId,
    },
  }
}
export function closeApKeyCreate(state: ApKeysState): ApKeysState {
  if (state.create.status === "pending") return state
  const create = state.create
  // A finished secret reveal resets; unknown keeps its locked request.
  const next: ApKeyCreateState =
    create.phase === "created"
      ? { ...create, open: false, phase: "form", createdKeyId: null }
      : { ...create, open: false }
  return {
    ...state,
    keys:
      create.phase === "created"
        ? state.keys.map((key) =>
            key.keyId === create.createdKeyId ? { ...key, secret: null } : key,
          )
        : state.keys,
    create: next,
  }
}
export function setApKeyDraft(
  state: ApKeysState,
  patch: Partial<ApKeyDraft>,
): ApKeysState {
  const create = state.create
  if (create.status === "pending" || create.status === "unknown") return state
  return {
    ...state,
    create: {
      ...create,
      draft: { ...create.draft, ...patch },
      error: null,
      status: create.status === "rejected" ? "idle" : create.status,
    },
  }
}
export function submitApKeyCreate(
  state: ApKeysState,
  request: ApKeyCreateRequest,
): ApKeysState {
  const create = state.create
  if (!state.canWrite) return state
  if (create.status === "pending" || create.status === "unknown") return state
  const name = create.draft.name.trim()
  if (name.length < 3)
    return { ...state, create: { ...create, error: "too-short" } }
  if (name.length > 48)
    return { ...state, create: { ...create, error: "too-long" } }
  const attempt = create.attempt + 1
  return {
    ...state,
    create: {
      ...create,
      error: null,
      status: "pending",
      intent: "create",
      operationId: `op-key-create-${attempt}`,
      receiptChecked: false,
      requestVersion: apAsOf,
      request: { ...request, name },
      attempt,
      createdKeyId: null,
    },
  }
}
export function checkApKeyCreate(state: ApKeysState): ApKeysState {
  if (!state.canWrite || state.create.status !== "unknown") return state
  return {
    ...state,
    create: { ...state.create, status: "pending", intent: "check" },
  }
}
/** Timer-driven settle for create; the check path only reads the receipt. */
export function resolveApKeyCreate(state: ApKeysState): ApKeysState {
  const create = state.create
  if (create.status !== "pending" || !create.request) return state
  if (create.intent === "check") {
    // Recorded receipt behind an unknown creation: rejected, never a secret.
    return {
      ...state,
      create: {
        ...create,
        status: apKeyCreateReceipt,
        intent: null,
        operationId: create.operationId,
        receiptChecked: true,
      },
    }
  }
  const request = create.request,
    outcome = apKeyCreateFixtureOutcome(state.keys, request)
  if (outcome === "confirmed") {
    const keyId = apKeyNextId(state.keys),
      secret = apKeyCreateSecret(keyId)
    const key: ApApiKey = {
      keyId,
      name: request.name.trim(),
      ownerMemberId: request.ownerMemberId,
      projectId: request.projectId,
      roleId: request.roleId,
      secretMask: apKeySecretMask(secret),
      secret,
      createdAt: apAsOf.slice(0, 10),
      expiresAt: request.expiresAt,
      revokedAt: null,
      lastUsedAt: null,
      spendMicroUsd: 0,
    }
    return {
      ...state,
      keys: [key, ...state.keys],
      create: {
        ...create,
        phase: "created",
        status: "confirmed",
        intent: null,
        operationId: null,
        createdKeyId: keyId,
        draft: { ...create.draft, name: "" },
      },
    }
  }
  if (outcome === "rejected")
    return {
      ...state,
      create: {
        ...create,
        status: "rejected",
        intent: null,
        operationId: null,
      },
    }
  // Unknown keeps the operation ID and the frozen request, and blocks replay.
  return { ...state, create: { ...create, status: "unknown", intent: null } }
}

export function openApKeyRevoke(
  state: ApKeysState,
  selectedIds: readonly string[],
  rows: readonly ApKeyRow[],
): ApKeysState {
  const revoke = state.revoke
  if (revoke.status === "pending" || revoke.status === "unknown") return state
  const selected = new Set(selectedIds)
  const chosen = rows.filter((row) => selected.has(row.keyId))
  const targetIds = chosen
    .filter((row) => row.status === "active")
    .map((row) => row.keyId)
  if (!targetIds.length) return state
  return {
    ...state,
    revoke: {
      ...revoke,
      open: true,
      targetIds,
      skippedIds: chosen
        .filter((row) => row.status !== "active")
        .map((row) => row.keyId),
      status: "idle",
      intent: null,
      operationId: null,
      request: null,
    },
  }
}
export function closeApKeyRevoke(state: ApKeysState): ApKeysState {
  if (state.revoke.status === "pending") return state
  return { ...state, revoke: { ...state.revoke, open: false } }
}
export function submitApKeyRevoke(state: ApKeysState): ApKeysState {
  const revoke = state.revoke
  if (!state.canWrite || !revoke.open || !revoke.targetIds.length) return state
  if (revoke.status === "pending" || revoke.status === "unknown") return state
  const attempt = revoke.attempt + 1
  return {
    ...state,
    revoke: {
      ...revoke,
      status: "pending",
      intent: "revoke",
      operationId: `op-key-revoke-${attempt}`,
      receiptChecked: false,
      requestVersion: apAsOf,
      request: { targetIds: [...revoke.targetIds] },
      attempt,
    },
  }
}
export function checkApKeyRevoke(state: ApKeysState): ApKeysState {
  if (!state.canWrite || state.revoke.status !== "unknown") return state
  return {
    ...state,
    revoke: { ...state.revoke, status: "pending", intent: "check" },
  }
}
function applyApKeyRevocation(
  state: ApKeysState,
  targetIds: readonly string[],
): ApKeysState {
  const revoked = new Set(targetIds),
    revokedAt = "2026-10-12"
  return {
    ...state,
    keys: state.keys.map((key) =>
      revoked.has(key.keyId) && !key.revokedAt ? { ...key, revokedAt } : key,
    ),
    selectedIds: state.selectedIds.filter((id) => !revoked.has(id)),
  }
}
/** Timer-driven settle for revoke; the check path only reads the receipt. */
export function resolveApKeyRevoke(state: ApKeysState): ApKeysState {
  const revoke = state.revoke
  if (revoke.status !== "pending" || !revoke.request) return state
  const targetIds = revoke.request.targetIds
  if (revoke.intent === "check") {
    const applied = applyApKeyRevocation(state, targetIds)
    return {
      ...applied,
      revoke: {
        ...revoke,
        status: apKeyRevokeReceipt,
        intent: null,
        operationId: revoke.operationId,
        receiptChecked: true,
        open: false,
      },
    }
  }
  const outcome = apKeyRevokeFixtureOutcome(state.keys, targetIds)
  if (outcome === "confirmed") {
    const applied = applyApKeyRevocation(state, targetIds)
    return {
      ...applied,
      revoke: {
        ...revoke,
        status: "confirmed",
        intent: null,
        operationId: null,
        open: false,
      },
    }
  }
  // Unknown keeps the operation ID and the frozen target IDs: no replay.
  return { ...state, revoke: { ...revoke, status: "unknown", intent: null } }
}
