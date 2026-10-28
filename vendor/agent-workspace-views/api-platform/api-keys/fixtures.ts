import {
  apAsOf,
  type ApCopy,
  type ApLocale,
  type ApScenario,
} from "../model.ts"

export type ApKeyStatus = "active" | "expired" | "revoked"
export type ApKeyPermission = "all" | "restricted" | "read-only"

/** API key metadata only. keyId is the tracking identity; the secret is separate. */
export type ApApiKey = {
  keyId: string
  name: string
  ownerMemberId: string
  projectId: string
  roleId: string
  secretMask: string
  /** Full secret exists only for keys created and confirmed in this local session. */
  secret: string | null
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  spendMicroUsd: number | null
}

export const apKeyStatusLabels: Record<ApKeyStatus, ApCopy> = {
  active: { "zh-CN": "生效中", en: "Active" },
  expired: { "zh-CN": "已过期", en: "Expired" },
  revoked: { "zh-CN": "已撤销", en: "Revoked" },
}
export const apKeyPermissionLabels: Record<ApKeyPermission, ApCopy> = {
  all: { "zh-CN": "全部权限", en: "All permissions" },
  restricted: { "zh-CN": "受限", en: "Restricted" },
  "read-only": { "zh-CN": "只读", en: "Read only" },
}

/** Credential resource permissions are distinct from the account role's administrative capabilities. */
export const apKeyResources = [
  { id: "responses", label: { "zh-CN": "响应", en: "Responses" } },
  { id: "files", label: { "zh-CN": "文件", en: "Files" } },
  { id: "vectorStores", label: { "zh-CN": "向量存储", en: "Vector stores" } },
  { id: "apiKeys", label: { "zh-CN": "API 密钥", en: "API keys" } },
] as const
type ApKeyResource = (typeof apKeyResources)[number]["id"]
type ApKeyAccess = "read" | "write" | "none"
export const apKeyResourceAccess: Record<
  ApKeyPermission,
  Record<ApKeyResource, ApKeyAccess>
> = {
  restricted: {
    responses: "write",
    files: "read",
    vectorStores: "none",
    apiKeys: "none",
  },
  "read-only": {
    responses: "read",
    files: "read",
    vectorStores: "read",
    apiKeys: "none",
  },
  all: {
    responses: "write",
    files: "write",
    vectorStores: "write",
    apiKeys: "write",
  },
}
export const apKeyAccessLabels: Record<ApKeyAccess, ApCopy> = {
  read: { "zh-CN": "读取", en: "Read" },
  write: { "zh-CN": "写入", en: "Write" },
  none: { "zh-CN": "无", en: "None" },
}
export const apKeyPermissionHints: Record<ApKeyPermission, ApCopy> = {
  restricted: {
    "zh-CN": "可创建响应和读取文件，无法管理密钥或账单。",
    en: "Can create responses and read files. Cannot manage keys or billing.",
  },
  "read-only": {
    "zh-CN": "可读取资源，无法创建响应或管理密钥。",
    en: "Can read resources. Cannot create responses or manage keys.",
  },
  all: {
    "zh-CN": "可读写项目中的全部资源，包括 API 密钥。",
    en: "Can read and write all project resources, including API keys.",
  },
}

/** Permission presets retain the canonical role ID, without copying account roles. */
export const apKeyPermissionRoleIds: Record<ApKeyPermission, string> = {
  all: "role-admin",
  restricted: "role-developer",
  "read-only": "role-viewer",
}
export const apKeyPermissionValues = Object.keys(
  apKeyPermissionRoleIds,
) as ApKeyPermission[]
/** Inverse of apKeyPermissionRoleIds; unknown roles stay unknown. */
export function apKeyPermissionForRole(roleId: string): ApKeyPermission | null {
  return (
    apKeyPermissionValues.find((p) => apKeyPermissionRoleIds[p] === roleId) ??
    null
  )
}

/**
 * Status derives from the fixed apAsOf snapshot, never the wall clock:
 * revoked beats expiry; a key expires the day after its expiry date.
 */
export function apKeyStatusOf(key: ApApiKey): ApKeyStatus {
  if (key.revokedAt) return "revoked"
  if (key.expiresAt && key.expiresAt < apAsOf.slice(0, 10)) return "expired"
  return "active"
}

export const apKeyExpirationOptions = [30, 90, 365] as const
export const apKeyDefaultExpirationDays = 90
export function apKeyExpiresAfter(days: number): string {
  return new Date(Date.parse(apAsOf) + days * 86_400_000)
    .toISOString()
    .slice(0, 10)
}
export function apKeyExpirationLabel(days: number, locale: ApLocale): string {
  if (locale === "en") return days === 365 ? "1 year" : `${days} days`
  return days === 365 ? "1 年" : `${days} 天`
}

const secretMarker = ".example.invalid"
/**
 * Secrets are obviously invalid local demo values carrying the
 * example.invalid / demo-fixture markers; nothing here is a credential.
 */
export function apKeyCreateSecret(keyId: string): string {
  return `demo-fixture_${keyId}${secretMarker}`
}
export function apKeySecretMask(secret: string): string {
  const nonce = secret.slice("demo-fixture_".length, -secretMarker.length)
  return `demo_···${nonce.slice(-4)}`
}
export function apKeyNextId(keys: readonly ApApiKey[]): string {
  let max = 0
  for (const key of keys) {
    const match = /^key_demo_(\d+)$/.exec(key.keyId)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `key_demo_${String(max + 1).padStart(3, "0")}`
}

type FixtureKey = Omit<ApApiKey, "secret">
/** Spend desc; the reference default order. Amounts are integer micro-USD. */
const fixtureKeys: FixtureKey[] = [
  {
    keyId: "key_demo_001",
    name: "Production · support",
    ownerMemberId: "member-lin",
    projectId: "api-project-demo",
    roleId: "role-developer",
    secretMask: "demo_···a7b2",
    createdAt: "2026-08-24",
    expiresAt: "2026-11-24",
    revokedAt: null,
    lastUsedAt: "2026-10-11T23:58:00Z",
    spendMicroUsd: 86_420_000,
  },
  {
    keyId: "key_demo_002",
    name: "Knowledge indexer",
    ownerMemberId: "member-river",
    projectId: "api-project-research",
    roleId: "role-developer",
    secretMask: "demo_···e91c",
    createdAt: "2026-08-30",
    expiresAt: "2026-11-28",
    revokedAt: null,
    lastUsedAt: "2026-10-11T23:48:00Z",
    spendMicroUsd: 54_180_000,
  },
  {
    keyId: "key_demo_003",
    name: "Content studio",
    ownerMemberId: "member-demo",
    projectId: "api-project-demo",
    roleId: "role-admin",
    secretMask: "demo_···ff80",
    createdAt: "2026-09-01",
    expiresAt: "2026-12-01",
    revokedAt: null,
    lastUsedAt: "2026-10-11T23:22:00Z",
    spendMicroUsd: 31_860_000,
  },
  {
    keyId: "key_demo_004",
    name: "Legacy content pipeline",
    ownerMemberId: "member-demo",
    projectId: "api-project-research",
    roleId: "role-admin",
    secretMask: "demo_···cc90",
    createdAt: "2026-06-12",
    expiresAt: "2027-06-12",
    revokedAt: "2026-09-07",
    lastUsedAt: "2026-09-07T10:00:00Z",
    spendMicroUsd: 7_410_000,
  },
  {
    keyId: "key_demo_005",
    name: "Staging · support",
    ownerMemberId: "member-lin",
    projectId: "api-project-demo",
    roleId: "role-developer",
    secretMask: "demo_···bb24",
    createdAt: "2026-07-06",
    expiresAt: "2026-12-04",
    revokedAt: null,
    lastUsedAt: "2026-10-10T22:00:00Z",
    spendMicroUsd: 4_290_000,
  },
  {
    keyId: "key_demo_006",
    name: "Analytics · read only",
    ownerMemberId: "member-demo",
    projectId: "api-project-demo",
    roleId: "role-viewer",
    secretMask: "demo_···09d3",
    createdAt: "2026-09-03",
    expiresAt: "2026-12-03",
    revokedAt: null,
    lastUsedAt: "2026-10-11T23:00:00Z",
    spendMicroUsd: 0,
  },
  {
    keyId: "key_demo_007",
    name: "Import migration",
    ownerMemberId: "member-river",
    projectId: "api-project-research",
    roleId: "role-developer",
    secretMask: "demo_···ae64",
    createdAt: "2026-06-01",
    expiresAt: "2026-09-01",
    revokedAt: null,
    lastUsedAt: "2026-08-31T09:30:00Z",
    spendMicroUsd: 0,
  },
]

/** Fixture entry: empty removes the collection; missing-data and long-content
 * alter records in place so every scene keeps the same stable selectors. */
export function createApApiKeys(scenario: ApScenario): ApApiKey[] {
  const keys = fixtureKeys.map((key) => ({ ...key, secret: null }))
  if (scenario === "empty") return []
  if (scenario === "missing-data") {
    // Owner and spend are genuinely unknown; an empty expiry stays a known
    // "never" and must not be read as a missing value or a zero.
    const analytics = keys.find((key) => key.keyId === "key_demo_006")
    if (analytics) {
      analytics.ownerMemberId = "member-removed"
      analytics.spendMicroUsd = null
    }
    const staging = keys.find((key) => key.keyId === "key_demo_005")
    if (staging) staging.expiresAt = null
  }
  if (scenario === "long-content") {
    keys[0].name =
      "Production support credential for the demonstration organization with an exceptionally long multilingual name · 超长多语言密钥名称"
  }
  return keys
}

export type ApKeyCreateRequest = {
  name: string
  ownerMemberId: string
  ownerInvited: boolean
  projectId: string
  roleId: string
  expiresAt: string
}
export type ApKeyFixtureOutcome = "confirmed" | "rejected" | "unknown"

/**
 * Documented creation outcomes for this fixture:
 * duplicate name -> rejected; an owner whose invitation is still pending ->
 * unknown (an explicit check resolves the recorded receipt); otherwise
 * confirmed. The receipt behind an unknown creation is always rejected, so an
 * unknown or rejected creation can never reveal a secret or insert a row.
 */
export function apKeyCreateFixtureOutcome(
  keys: readonly ApApiKey[],
  request: ApKeyCreateRequest,
): ApKeyFixtureOutcome {
  const name = request.name.trim().toLowerCase()
  if (keys.some((key) => key.name.trim().toLowerCase() === name))
    return "rejected"
  if (request.ownerInvited) return "unknown"
  return "confirmed"
}
export const apKeyCreateReceipt: ApKeyFixtureOutcome = "rejected"

/**
 * Documented revocation outcomes: revoking any key with the all-permissions
 * role is confirmed asynchronously in this fixture (unknown); an explicit
 * check resolves the recorded receipt, which is confirmed. Any other revoke
 * confirms directly.
 */
export function apKeyRevokeFixtureOutcome(
  keys: readonly ApApiKey[],
  targetIds: readonly string[],
): ApKeyFixtureOutcome {
  const elevated = targetIds.some((id) => {
    const key = keys.find((candidate) => candidate.keyId === id)
    return key ? apKeyPermissionForRole(key.roleId) === "all" : false
  })
  return elevated ? "unknown" : "confirmed"
}
export const apKeyRevokeReceipt: ApKeyFixtureOutcome = "confirmed"

export function formatApKeySpend(
  microUsd: number | null,
  locale: ApLocale,
): string {
  if (microUsd === null) return locale === "en" ? "Unknown" : "未知"
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
  }).format(microUsd / 1_000_000)
}

const withTime = (date: string) =>
  date.length === 10 ? `${date}T00:00:00Z` : date
export function formatApKeyDate(date: string, locale: ApLocale): string {
  return locale === "en"
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(withTime(date)))
    : new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      }).format(new Date(withTime(date)))
}
/** Revoked expiry cells show the revocation date, matching the reference. */
export function formatApKeyRevokedDate(date: string, locale: ApLocale): string {
  const short =
    locale === "en"
      ? new Intl.DateTimeFormat("en-US", {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(new Date(withTime(date)))
      : new Intl.DateTimeFormat("zh-CN", {
          month: "long",
          day: "numeric",
          timeZone: "UTC",
        }).format(new Date(withTime(date)))
  return locale === "en" ? `Revoked ${short}` : `已撤销 ${short}`
}
/** Relative to apAsOf; null means the key was never used, which is not zero
 * and not an unknown value. Unknown amounts stay explicit in spendMicroUsd. */
export function formatApKeyLastUsed(
  date: string | null,
  locale: ApLocale,
): string {
  if (!date) return locale === "en" ? "Never used" : "从未使用"
  const diffMs = Math.max(0, Date.parse(apAsOf) - Date.parse(withTime(date)))
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return locale === "en" ? "Just now" : "刚刚"
  if (minutes < 60)
    return locale === "en" ? `${minutes} min ago` : `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return locale === "en" ? `${hours} hr ago` : `${hours} 小时前`
  if (hours < 48) return locale === "en" ? "Yesterday" : "昨天"
  const days = Math.floor(hours / 24)
  if (days < 7) return locale === "en" ? `${days} days ago` : `${days} 天前`
  return locale === "en"
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(new Date(withTime(date)))
    : new Intl.DateTimeFormat("zh-CN", {
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      }).format(new Date(withTime(date)))
}
