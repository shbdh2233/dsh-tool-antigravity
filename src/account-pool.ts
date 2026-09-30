/** Multi-account pool management, persistent storage, and scheduled quota monitoring / auto-switch. */

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defaultAuthStorePath, type AntigravityAuthRecord, type AntigravityAuthStore } from './auth-store.ts'
import type { QuotaStatusView, QuotaState } from './quota.ts'
import { createGoogleRefreshTransport } from './credential-coordinator.ts'
import { createPrivateTransport, type PrivateTransport } from './private-transport.ts'
import { ANTIGRAVITY_QUOTA_ENDPOINT, normalizeQuotaResponse } from './quota.ts'

export const ACCOUNT_POOL_VERSION = 1 as const
export const DEFAULT_QUOTA_THRESHOLD = 0.10 // 10%
export const DEFAULT_CHECK_INTERVAL_SECONDS = 120 // 2 minutes
export const MIN_CHECK_INTERVAL_SECONDS = 30

export interface AccountQuotaSummary {
  readonly remainingFraction: number // 0.0 to 1.0 (min across windows)
  readonly window5hFraction?: number | undefined
  readonly windowWeeklyFraction?: number | undefined
  readonly checkedAt: string
  readonly state: QuotaState
}

export interface AccountPoolItem {
  readonly id: string
  readonly email?: string | undefined
  readonly refreshToken: string
  readonly projectId: string
  readonly lineage?: string | undefined
  readonly addedAt: string
  readonly updatedAt: string
  quota?: AccountQuotaSummary | undefined
}

export interface AccountPoolItemView {
  readonly id: string
  readonly email?: string | undefined
  readonly projectId: string
  readonly addedAt: string
  readonly updatedAt: string
  readonly isActive: boolean
  readonly quota?: AccountQuotaSummary | undefined
}

export interface AccountPoolConfig {
  readonly autoSwitch: boolean
  readonly quotaThreshold: number // e.g. 0.10 for 10%
  readonly checkIntervalSeconds: number // in seconds
}

export interface AccountPoolRecord {
  readonly version: typeof ACCOUNT_POOL_VERSION
  readonly activeAccountId?: string | undefined
  readonly accounts: readonly AccountPoolItem[]
  readonly config: AccountPoolConfig
}

export interface AccountPoolStatusView {
  readonly activeAccountId?: string | undefined
  readonly accounts: readonly AccountPoolItemView[]
  readonly config: AccountPoolConfig
  readonly lastCheckedAt?: string | undefined
  readonly lastSwitchedAt?: string | undefined
  readonly switchReason?: string | undefined
}

export interface AccountPoolOptions {
  readonly store?: AntigravityAuthStore | undefined
  readonly storePath?: string | undefined
  readonly poolPath?: string | undefined
  readonly isMemory?: boolean | undefined
  readonly now?: (() => number) | undefined
  readonly fetchImpl?: typeof fetch | undefined
  readonly transport?: PrivateTransport | undefined
  readonly onActiveAccountChange?: ((account: AccountPoolItem, reason: string) => Promise<void> | void) | undefined
}

export interface AccountPoolManager {
  readonly poolPath: string
  getAccounts(): Promise<readonly AccountPoolItem[]>
  getActiveAccount(): Promise<AccountPoolItem | undefined>
  addOrUpdateAccount(draft: {
    readonly refreshToken: string
    readonly projectId: string
    readonly email?: string
    readonly lineage?: string
  }): Promise<AccountPoolItem>
  switchAccount(id: string, reason?: string): Promise<AccountPoolItem | undefined>
  removeAccount(id: string): Promise<boolean>
  updateConfig(patch: Partial<AccountPoolConfig>): Promise<AccountPoolConfig>
  getConfig(): AccountPoolConfig
  statusView(): Promise<AccountPoolStatusView>
  checkQuotasAndAutoSwitch(forceCheckAll?: boolean): Promise<{
    readonly switched: boolean
    readonly previousAccountId?: string
    readonly currentAccountId?: string
    readonly reason?: string
  }>
  checkAccountQuota(account: AccountPoolItem): Promise<AccountQuotaSummary | undefined>
  startScheduler(): void
  stopScheduler(): void
  dispose(): Promise<void>
}

export function defaultAccountPoolPath(storePath?: string): string {
  const baseStore = storePath ?? defaultAuthStorePath()
  return join(dirname(baseStore), 'accounts.json')
}

export function createAccountPool(options: AccountPoolOptions = {}): AccountPoolManager {
  const now = options.now ?? (() => Date.now())
  const isMemory = options.isMemory ?? (options.store !== undefined && options.storePath === undefined && options.poolPath === undefined)
  const poolPath = options.poolPath ?? defaultAccountPoolPath(options.storePath)
  const legacyStorePath = options.storePath ?? defaultAuthStorePath()
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const transport = options.transport ?? createPrivateTransport()

  let cachedRecord: AccountPoolRecord | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let checking = false
  let lastCheckedAt: string | undefined
  let lastSwitchedAt: string | undefined
  let switchReason: string | undefined
  let disposed = false

  const refreshTransport = createGoogleRefreshTransport(fetchImpl, now)

  async function loadRecord(): Promise<AccountPoolRecord> {
    if (cachedRecord !== undefined) return cachedRecord

    if (isMemory) {
      // In memory mode, check if store has an initial record
      if (options.store) {
        try {
          const storeRecord = await options.store.read()
          if (storeRecord) {
            const id = storeRecord.lineage ?? 'mem-acc-1'
            const memRecord: AccountPoolRecord = {
              version: ACCOUNT_POOL_VERSION,
              activeAccountId: id,
              accounts: [{
                id,
                email: storeRecord.email,
                refreshToken: storeRecord.refreshToken,
                projectId: storeRecord.projectId,
                lineage: storeRecord.lineage,
                addedAt: storeRecord.updatedAt,
                updatedAt: storeRecord.updatedAt,
              }],
              config: {
                autoSwitch: true,
                quotaThreshold: DEFAULT_QUOTA_THRESHOLD,
                checkIntervalSeconds: DEFAULT_CHECK_INTERVAL_SECONDS,
              },
            }
            cachedRecord = memRecord
            return memRecord
          }
        } catch {}
      }
      const emptyRecord: AccountPoolRecord = {
        version: ACCOUNT_POOL_VERSION,
        accounts: [],
        config: {
          autoSwitch: true,
          quotaThreshold: DEFAULT_QUOTA_THRESHOLD,
          checkIntervalSeconds: DEFAULT_CHECK_INTERVAL_SECONDS,
        },
      }
      cachedRecord = emptyRecord
      return emptyRecord
    }

    let parsed: unknown
    try {
      const text = await readFile(poolPath, 'utf8')
      parsed = JSON.parse(text)
    } catch {
      // If pool doesn't exist yet, try to import from legacy auth.json
      const imported = await importFromLegacyStore(legacyStorePath)
      if (imported) {
        cachedRecord = imported
        await saveRecord(imported)
        return imported
      }
      cachedRecord = {
        version: ACCOUNT_POOL_VERSION,
        accounts: [],
        config: {
          autoSwitch: true,
          quotaThreshold: DEFAULT_QUOTA_THRESHOLD,
          checkIntervalSeconds: DEFAULT_CHECK_INTERVAL_SECONDS,
        },
      }
      return cachedRecord
    }

    if (isValidPoolRecord(parsed)) {
      // Reconcile with auth.json: if auth.json has an account not present in pool, merge it
      const legacy = await importFromLegacyStore(legacyStorePath)
      if (legacy && legacy.accounts.length > 0) {
        const legacyAcc = legacy.accounts[0]!
        const exists = parsed.accounts.some(a =>
          a.refreshToken === legacyAcc.refreshToken ||
          (a.lineage && legacyAcc.lineage && a.lineage === legacyAcc.lineage) ||
          (a.email && legacyAcc.email && a.email === legacyAcc.email),
        )
        if (!exists) {
          const reconciled: AccountPoolRecord = {
            ...parsed,
            activeAccountId: legacyAcc.id,
            accounts: [...parsed.accounts, legacyAcc],
          }
          cachedRecord = reconciled
          await saveRecord(reconciled)
          return reconciled
        }
      }
      cachedRecord = parsed
      return parsed
    }

    cachedRecord = {
      version: ACCOUNT_POOL_VERSION,
      accounts: [],
      config: {
        autoSwitch: true,
        quotaThreshold: DEFAULT_QUOTA_THRESHOLD,
        checkIntervalSeconds: DEFAULT_CHECK_INTERVAL_SECONDS,
      },
    }
    return cachedRecord
  }

  async function saveRecord(record: AccountPoolRecord): Promise<void> {
    cachedRecord = record
    if (isMemory) return

    const parent = dirname(poolPath)
    try {
      await mkdir(parent, { recursive: true, mode: 0o700 })
      await chmod(parent, 0o700).catch(() => {})
      const tmp = join(parent, `.accounts-${randomUUID()}.tmp`)
      const handle = await open(tmp, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close().catch(() => {})
      }
      await chmod(tmp, 0o600).catch(() => {})
      const { rename } = await import('node:fs/promises')
      await rename(tmp, poolPath)
      await chmod(poolPath, 0o600).catch(() => {})
    } catch {
      // Fallback
    }
  }

  async function importFromLegacyStore(path: string): Promise<AccountPoolRecord | undefined> {
    try {
      const text = await readFile(path, 'utf8')
      const legacy = JSON.parse(text) as AntigravityAuthRecord
      if (legacy && typeof legacy.refreshToken === 'string' && typeof legacy.projectId === 'string') {
        const id = legacy.lineage ?? randomUUID()
        const account: AccountPoolItem = {
          id,
          refreshToken: legacy.refreshToken,
          projectId: legacy.projectId,
          addedAt: legacy.updatedAt ?? new Date(now()).toISOString(),
          updatedAt: legacy.updatedAt ?? new Date(now()).toISOString(),
          ...(legacy.email !== undefined ? { email: legacy.email } : {}),
          ...(legacy.lineage !== undefined ? { lineage: legacy.lineage } : {}),
        }
        return {
          version: ACCOUNT_POOL_VERSION,
          activeAccountId: id,
          accounts: [account],
          config: {
            autoSwitch: true,
            quotaThreshold: DEFAULT_QUOTA_THRESHOLD,
            checkIntervalSeconds: DEFAULT_CHECK_INTERVAL_SECONDS,
          },
        }
      }
    } catch {
      // No legacy store or invalid
    }
    return undefined
  }

  async function getActiveAccount(): Promise<AccountPoolItem | undefined> {
    const record = await loadRecord()
    if (!record.activeAccountId) return record.accounts[0]
    return record.accounts.find(a => a.id === record.activeAccountId) ?? record.accounts[0]
  }

  async function addOrUpdateAccount(draft: {
    readonly refreshToken: string
    readonly projectId: string
    readonly email?: string
    readonly lineage?: string
  }): Promise<AccountPoolItem> {
    const record = await loadRecord()
    const isoNow = new Date(now()).toISOString()
    const existingIndex = record.accounts.findIndex(a =>
      (draft.lineage && a.lineage === draft.lineage) ||
      (draft.email && a.email && draft.email === a.email) ||
      a.refreshToken === draft.refreshToken,
    )

    let updatedAccounts: AccountPoolItem[]
    let activeId: string

    if (existingIndex >= 0) {
      const existing = record.accounts[existingIndex]!
      const updated: AccountPoolItem = {
        ...existing,
        refreshToken: draft.refreshToken,
        projectId: draft.projectId,
        ...(draft.email ? { email: draft.email } : {}),
        ...(draft.lineage ? { lineage: draft.lineage } : {}),
        updatedAt: isoNow,
      }
      updatedAccounts = [...record.accounts]
      updatedAccounts[existingIndex] = updated
      activeId = updated.id
    } else {
      const newId = draft.lineage ?? `acc_${randomUUID().slice(0, 8)}`
      const newAccount: AccountPoolItem = {
        id: newId,
        refreshToken: draft.refreshToken,
        projectId: draft.projectId,
        addedAt: isoNow,
        updatedAt: isoNow,
        ...(draft.email !== undefined ? { email: draft.email } : {}),
        ...(draft.lineage !== undefined ? { lineage: draft.lineage } : {}),
      }
      updatedAccounts = [...record.accounts, newAccount]
      activeId = newId
    }

    const nextRecord: AccountPoolRecord = {
      ...record,
      activeAccountId: activeId,
      accounts: updatedAccounts,
    }
    await saveRecord(nextRecord)

    const activeAcc = updatedAccounts.find(a => a.id === activeId)!
    try {
      await options.onActiveAccountChange?.(activeAcc, 'login')
    } catch {}

    return activeAcc
  }

  async function switchAccount(id: string, reason = 'manual'): Promise<AccountPoolItem | undefined> {
    const record = await loadRecord()
    const target = record.accounts.find(a => a.id === id)
    if (!target) return undefined

    const nextRecord: AccountPoolRecord = {
      ...record,
      activeAccountId: target.id,
    }
    await saveRecord(nextRecord)

    lastSwitchedAt = new Date(now()).toISOString()
    switchReason = reason

    try {
      await options.onActiveAccountChange?.(target, reason)
    } catch {}

    return target
  }

  async function removeAccount(id: string): Promise<boolean> {
    const record = await loadRecord()
    const targetIndex = record.accounts.findIndex(a => a.id === id)
    if (targetIndex < 0) return false

    const updatedAccounts = record.accounts.filter(a => a.id !== id)
    let nextActiveId = record.activeAccountId

    if (record.activeAccountId === id) {
      nextActiveId = updatedAccounts[0]?.id
    }

    const nextRecord: AccountPoolRecord = {
      version: record.version,
      config: record.config,
      accounts: updatedAccounts,
      ...(nextActiveId !== undefined ? { activeAccountId: nextActiveId } : {}),
    }
    await saveRecord(nextRecord)

    if (nextActiveId) {
      const nextActive = updatedAccounts.find(a => a.id === nextActiveId)
      if (nextActive) {
        try {
          await options.onActiveAccountChange?.(nextActive, 'removed-active')
        } catch {}
      }
    }

    return true
  }

  async function updateConfig(patch: Partial<AccountPoolConfig>): Promise<AccountPoolConfig> {
    const record = await loadRecord()
    const threshold = patch.quotaThreshold !== undefined
      ? Math.max(0.01, Math.min(1.0, patch.quotaThreshold))
      : record.config.quotaThreshold
    const interval = patch.checkIntervalSeconds !== undefined
      ? Math.max(MIN_CHECK_INTERVAL_SECONDS, patch.checkIntervalSeconds)
      : record.config.checkIntervalSeconds
    const autoSwitch = patch.autoSwitch !== undefined
      ? Boolean(patch.autoSwitch)
      : record.config.autoSwitch

    const newConfig: AccountPoolConfig = {
      autoSwitch,
      quotaThreshold: threshold,
      checkIntervalSeconds: interval,
    }

    const nextRecord: AccountPoolRecord = {
      ...record,
      config: newConfig,
    }
    await saveRecord(nextRecord)

    // Restart timer with new interval if active
    if (timer) {
      stopScheduler()
      startScheduler()
    }

    return newConfig
  }

  async function checkAccountQuota(account: AccountPoolItem): Promise<AccountQuotaSummary | undefined> {
    const abortCtrl = new AbortController()
    const timerId = setTimeout(() => abortCtrl.abort(), 15_000)
    try {
      const refreshResult = await refreshTransport({
        refreshToken: account.refreshToken,
        signal: abortCtrl.signal,
      })
      if (!refreshResult?.accessToken) return undefined

      const body = account.projectId ? { project: account.projectId } : {}
      let response = await transport.request({
        url: ANTIGRAVITY_QUOTA_ENDPOINT,
        accessToken: refreshResult.accessToken,
        body: JSON.stringify(body),
        signal: abortCtrl.signal,
      })
      if (response.status === 403 && account.projectId) {
        try {
          const retryResponse = await transport.request({
            url: ANTIGRAVITY_QUOTA_ENDPOINT,
            accessToken: refreshResult.accessToken,
            body: JSON.stringify({}),
            signal: abortCtrl.signal,
          })
          if (retryResponse.ok) response = retryResponse
        } catch {}
      }
      if (!response.ok) {
        if (response.status === 429) {
          return {
            remainingFraction: 0,
            checkedAt: new Date(now()).toISOString(),
            state: 'rate-limited',
          }
        }
        return undefined
      }

      const jsonText = await response.text()
      const data = JSON.parse(jsonText) as unknown
      const normalized = normalizeQuotaResponse(data, now())

      return extractSummaryFromQuotaView(normalized, now())
    } catch {
      return undefined
    } finally {
      clearTimeout(timerId)
    }
  }

  async function checkQuotasAndAutoSwitch(forceCheckAll = false): Promise<{
    readonly switched: boolean
    readonly previousAccountId?: string
    readonly currentAccountId?: string
    readonly reason?: string
  }> {
    if (checking || disposed) {
      return { switched: false }
    }
    checking = true
    try {
      const record = await loadRecord()
      if (record.accounts.length === 0) {
        return { switched: false }
      }

      const active = await getActiveAccount()
      if (!active) {
        return { switched: false }
      }

      lastCheckedAt = new Date(now()).toISOString()

      // Check active account quota
      const activeQuota = await manager.checkAccountQuota(active)
      if (activeQuota) {
        active.quota = activeQuota
      }

      // If requested or if active quota is low, check other accounts
      if (forceCheckAll || (activeQuota && activeQuota.remainingFraction <= record.config.quotaThreshold)) {
        for (const acc of record.accounts) {
          if (acc.id === active.id) continue
          const q = await manager.checkAccountQuota(acc)
          if (q) acc.quota = q
        }
      }

      await saveRecord(record)

      // Auto-switch evaluation
      if (record.config.autoSwitch && record.accounts.length > 1 && active.quota) {
        if (active.quota.remainingFraction <= record.config.quotaThreshold) {
          // Active account quota is below threshold (e.g. <= 10%)
          // Find next available account with quota > threshold, prioritizing highest quota
          const otherAccounts = record.accounts.filter(a => a.id !== active.id)
          const healthy = otherAccounts
            .filter(a => a.quota && a.quota.remainingFraction > record.config.quotaThreshold)
            .sort((a, b) => (b.quota?.remainingFraction ?? 0) - (a.quota?.remainingFraction ?? 0))

          const unknown = otherAccounts.filter(a => !a.quota)

          const exhausted = otherAccounts
            .filter(a => a.quota && a.quota.remainingFraction <= record.config.quotaThreshold)
            .sort((a, b) => (b.quota?.remainingFraction ?? 0) - (a.quota?.remainingFraction ?? 0))

          let nextAccount: AccountPoolItem | undefined
          if (healthy.length > 0) {
            nextAccount = healthy[0]
          } else if (unknown.length > 0) {
            nextAccount = unknown[0]
          } else if (exhausted.length > 0 && (exhausted[0]?.quota?.remainingFraction ?? 0) > active.quota.remainingFraction) {
            nextAccount = exhausted[0]
          }

          if (nextAccount && nextAccount.id !== active.id) {
            const reason = `Quota for ${active.email ?? active.id} dropped to ${(active.quota.remainingFraction * 100).toFixed(1)}% (threshold: ${(record.config.quotaThreshold * 100).toFixed(0)}%). Auto-switched to ${nextAccount.email ?? nextAccount.id}`
            await switchAccount(nextAccount.id, reason)
            return {
              switched: true,
              previousAccountId: active.id,
              currentAccountId: nextAccount.id,
              reason,
            }
          }
        }
      }

      return { switched: false, currentAccountId: active.id }
    } finally {
      checking = false
    }
  }

  function startScheduler(): void {
    if (timer || disposed) return
    const intervalMs = Math.max(MIN_CHECK_INTERVAL_SECONDS, cachedRecord?.config.checkIntervalSeconds ?? DEFAULT_CHECK_INTERVAL_SECONDS) * 1000
    timer = setInterval(() => {
      void checkQuotasAndAutoSwitch(false).catch(() => {})
    }, intervalMs)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  function stopScheduler(): void {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  async function statusView(): Promise<AccountPoolStatusView> {
    const record = await loadRecord()
    const active = await getActiveAccount()
    const views: AccountPoolItemView[] = record.accounts.map(a => ({
      id: a.id,
      projectId: a.projectId,
      addedAt: a.addedAt,
      updatedAt: a.updatedAt,
      isActive: a.id === active?.id,
      ...(a.email !== undefined ? { email: a.email } : {}),
      ...(a.quota !== undefined ? { quota: a.quota } : {}),
    }))

    return {
      accounts: views,
      config: { ...record.config },
      ...(active?.id !== undefined ? { activeAccountId: active.id } : {}),
      ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}),
      ...(lastSwitchedAt !== undefined ? { lastSwitchedAt } : {}),
      ...(switchReason !== undefined ? { switchReason } : {}),
    }
  }

  const manager: AccountPoolManager = {
    poolPath,
    getAccounts: async () => (await loadRecord()).accounts,
    getActiveAccount,
    addOrUpdateAccount,
    switchAccount,
    removeAccount,
    updateConfig,
    getConfig: () => cachedRecord?.config ?? {
      autoSwitch: true,
      quotaThreshold: DEFAULT_QUOTA_THRESHOLD,
      checkIntervalSeconds: DEFAULT_CHECK_INTERVAL_SECONDS,
    },
    statusView,
    checkQuotasAndAutoSwitch,
    checkAccountQuota: account => checkAccountQuota(account),
    startScheduler,
    stopScheduler,
    dispose: async () => {
      disposed = true
      stopScheduler()
    },
  }

  return manager
}

export function extractSummaryFromQuotaView(view: QuotaStatusView, now: number): AccountQuotaSummary {
  let minFraction = 1.0
  let window5h: number | undefined
  let windowWeekly: number | undefined

  for (const group of view.groups ?? []) {
    // Ignore non-gemini quotas (Claude/GPT) to prevent false-positive auto-switching
    if (group.group !== 'gemini') continue

    for (const win of group.windows) {
      if (win.remainingFraction < minFraction) {
        minFraction = win.remainingFraction
      }
      if (win.window === '5h') {
        window5h = window5h === undefined ? win.remainingFraction : Math.min(window5h, win.remainingFraction)
      } else if (win.window === 'weekly') {
        windowWeekly = windowWeekly === undefined ? win.remainingFraction : Math.min(windowWeekly, win.remainingFraction)
      }
    }
  }

  return {
    remainingFraction: minFraction,
    ...(window5h !== undefined ? { window5hFraction: window5h } : {}),
    ...(windowWeekly !== undefined ? { windowWeeklyFraction: windowWeekly } : {}),
    checkedAt: view.checkedAt ?? new Date(now).toISOString(),
    state: view.state,
  }
}

function isValidPoolRecord(value: unknown): value is AccountPoolRecord {
  if (!isRecord(value)) return false
  if (value.version !== ACCOUNT_POOL_VERSION) return false
  if (!Array.isArray(value.accounts)) return false
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
