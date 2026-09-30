import { describe, expect, it, vi } from 'vitest'
import {
  createAccountPool,
  extractSummaryFromQuotaView,
  type AccountPoolItem,
  type AccountQuotaSummary,
} from '../src/account-pool.ts'
import { createMemoryAuthStore } from '../src/auth-store.ts'
import type { QuotaStatusView } from '../src/quota.ts'
import { handleAntigravityAuthRpc } from '../src/rpc.ts'

describe('Antigravity Multi-Account Pool & Quota Auto-Switch', () => {
  it('adds multiple accounts and maintains both in the pool without overwriting', async () => {
    const store = createMemoryAuthStore()
    const pool = createAccountPool({ store, isMemory: true })

    const acc1 = await pool.addOrUpdateAccount({
      refreshToken: 'refresh-acc-1',
      projectId: 'project-acc-1',
      email: 'user1@example.com',
    })
    expect(acc1.email).toBe('user1@example.com')

    let accounts = await pool.getAccounts()
    expect(accounts).toHaveLength(1)
    expect((await pool.getActiveAccount())?.id).toBe(acc1.id)

    // Add second account
    const acc2 = await pool.addOrUpdateAccount({
      refreshToken: 'refresh-acc-2',
      projectId: 'project-acc-2',
      email: 'user2@example.com',
    })
    expect(acc2.email).toBe('user2@example.com')

    accounts = await pool.getAccounts()
    expect(accounts).toHaveLength(2)
    expect(accounts.map(a => a.email)).toEqual(['user1@example.com', 'user2@example.com'])
    // Newly added account becomes active
    expect((await pool.getActiveAccount())?.id).toBe(acc2.id)

    // Switch back to account 1
    const switched = await pool.switchAccount(acc1.id, 'manual-switch')
    expect(switched?.id).toBe(acc1.id)
    expect((await pool.getActiveAccount())?.id).toBe(acc1.id)

    // Status view shows active status correctly
    const view = await pool.statusView()
    expect(view.accounts).toHaveLength(2)
    expect(view.accounts.find(a => a.id === acc1.id)?.isActive).toBe(true)
    expect(view.accounts.find(a => a.id === acc2.id)?.isActive).toBe(false)
  })

  it('removes an account from the pool and updates active account if needed', async () => {
    const pool = createAccountPool({ isMemory: true })
    const acc1 = await pool.addOrUpdateAccount({
      refreshToken: 'refresh-1',
      projectId: 'proj-1',
      email: 'acc1@example.com',
    })
    const acc2 = await pool.addOrUpdateAccount({
      refreshToken: 'refresh-2',
      projectId: 'proj-2',
      email: 'acc2@example.com',
    })

    expect((await pool.getActiveAccount())?.id).toBe(acc2.id)

    // Remove active account acc2
    const removed = await pool.removeAccount(acc2.id)
    expect(removed).toBe(true)

    const remaining = await pool.getAccounts()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.id).toBe(acc1.id)
    // Active account automatically falls back to acc1
    expect((await pool.getActiveAccount())?.id).toBe(acc1.id)
  })

  it('extracts min quota fraction strictly from gemini windows, ignoring non-gemini', () => {
    const quotaView: QuotaStatusView = {
      state: 'available',
      checkedAt: '2026-09-25T00:00:00.000Z',
      groups: [
        {
          group: 'gemini',
          modelCount: 2,
          windows: [
            { window: '5h', remainingFraction: 0.15, resetTime: '2026-09-25T05:00:00.000Z' },
            { window: 'weekly', remainingFraction: 0.50, resetTime: '2026-09-30T00:00:00.000Z' },
          ],
        },
        {
          group: 'non-gemini',
          modelCount: 3,
          windows: [
            { window: '5h', remainingFraction: 0.08, resetTime: '2026-09-25T05:00:00.000Z' },
            { window: 'weekly', remainingFraction: 0.80, resetTime: '2026-09-30T00:00:00.000Z' },
          ],
        },
      ],
    }

    const summary = extractSummaryFromQuotaView(quotaView, Date.now())
    // Should ignore the 0.08 from non-gemini, and pick 0.15 from gemini
    expect(summary.remainingFraction).toBe(0.15)
    expect(summary.state).toBe('available')
  })

  it('automatically switches to the next account when active account quota drops below 10%', async () => {
    const onChange = vi.fn()
    const pool = createAccountPool({
      isMemory: true,
      onActiveAccountChange: onChange,
    })

    const acc1 = await pool.addOrUpdateAccount({
      refreshToken: 'ref-1',
      projectId: 'p-1',
      email: 'acc1@gmail.com',
    })
    const acc2 = await pool.addOrUpdateAccount({
      refreshToken: 'ref-2',
      projectId: 'p-2',
      email: 'acc2@gmail.com',
    })

    // Set acc1 as active
    await pool.switchAccount(acc1.id)
    onChange.mockClear()

    // Mock checkAccountQuota: acc1 has 8% quota (< 10%), acc2 has 85% quota
    vi.spyOn(pool, 'checkAccountQuota').mockImplementation(async (account: AccountPoolItem) => {
      if (account.id === acc1.id) {
        return {
          remainingFraction: 0.08, // 8% -> below 10%
          window5hFraction: 0.08,
          checkedAt: new Date().toISOString(),
          state: 'available',
        }
      }
      return {
        remainingFraction: 0.85, // 85% -> healthy
        window5hFraction: 0.85,
        checkedAt: new Date().toISOString(),
        state: 'available',
      }
    })

    const result = await pool.checkQuotasAndAutoSwitch(false)
    expect(result.switched).toBe(true)
    expect(result.previousAccountId).toBe(acc1.id)
    expect(result.currentAccountId).toBe(acc2.id)
    expect(result.reason).toContain('dropped to 8.0%')

    expect((await pool.getActiveAccount())?.id).toBe(acc2.id)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: acc2.id }), expect.any(String))
  })

  it('does not switch when active account quota is above 10%', async () => {
    const onChange = vi.fn()
    const pool = createAccountPool({
      isMemory: true,
      onActiveAccountChange: onChange,
    })

    const acc1 = await pool.addOrUpdateAccount({
      refreshToken: 'ref-1',
      projectId: 'p-1',
      email: 'healthy@gmail.com',
    })
    await pool.addOrUpdateAccount({
      refreshToken: 'ref-2',
      projectId: 'p-2',
      email: 'standby@gmail.com',
    })

    await pool.switchAccount(acc1.id)
    onChange.mockClear()

    vi.spyOn(pool, 'checkAccountQuota').mockResolvedValue({
      remainingFraction: 0.45, // 45% -> well above 10%
      checkedAt: new Date().toISOString(),
      state: 'available',
    })

    const result = await pool.checkQuotasAndAutoSwitch(false)
    expect(result.switched).toBe(false)
    expect((await pool.getActiveAccount())?.id).toBe(acc1.id)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('serves multi-account pool RPC endpoints', async () => {
    const pool = createAccountPool({ isMemory: true })
    const acc1 = await pool.addOrUpdateAccount({
      refreshToken: 'ref-1',
      projectId: 'p-1',
      email: 'rpc-acc-1@gmail.com',
    })
    const acc2 = await pool.addOrUpdateAccount({
      refreshToken: 'ref-2',
      projectId: 'p-2',
      email: 'rpc-acc-2@gmail.com',
    })

    const service = {
      status: vi.fn(),
      acknowledgeRisk: vi.fn(),
      startLogin: vi.fn(),
      cancelLogin: vi.fn(),
      logout: vi.fn(),
      revoke: vi.fn(),
      poolStatus: async () => pool.statusView(),
      switchAccount: async (id: string) => pool.switchAccount(id),
      removeAccount: async (id: string) => pool.removeAccount(id),
      updatePoolConfig: async (cfg: Parameters<typeof pool.updateConfig>[0]) => pool.updateConfig(cfg),
      checkQuotas: async (forceAll?: boolean) => pool.checkQuotasAndAutoSwitch(forceAll),
    }

    const signal = new AbortController().signal

    // RPC: accounts
    const accountsRes = await handleAntigravityAuthRpc(service, 'accounts', {}, signal)
    expect(accountsRes).toMatchObject({
      ok: true,
      value: {
        pool: {
          accounts: expect.arrayContaining([
            expect.objectContaining({ email: 'rpc-acc-1@gmail.com' }),
            expect.objectContaining({ email: 'rpc-acc-2@gmail.com' }),
          ]),
        },
      },
    })

    // RPC: switch-account
    const switchRes = await handleAntigravityAuthRpc(service, 'switch-account', { id: acc1.id }, signal)
    expect(switchRes).toEqual({
      ok: true,
      value: { activeAccountId: acc1.id, switched: true },
    })
    expect((await pool.getActiveAccount())?.id).toBe(acc1.id)

    // RPC: set-pool-config
    const configRes = await handleAntigravityAuthRpc(service, 'set-pool-config', { quotaThreshold: 0.15, autoSwitch: false }, signal)
    expect(configRes).toMatchObject({
      ok: true,
      value: { config: { quotaThreshold: 0.15, autoSwitch: false } },
    })

    // RPC: remove-account
    const removeRes = await handleAntigravityAuthRpc(service, 'remove-account', { id: acc2.id }, signal)
    expect(removeRes).toEqual({
      ok: true,
      value: { removed: true },
    })
    expect((await pool.getAccounts())).toHaveLength(1)
  })

  it('prioritizes healthy account with highest remaining quota (> 10%) over unknown and exhausted accounts', async () => {
    const pool = createAccountPool({ isMemory: true })
    const acc1 = await pool.addOrUpdateAccount({
      refreshToken: 'ref-1',
      projectId: 'p-1',
      email: 'acc1@gmail.com',
    })
    const acc2 = await pool.addOrUpdateAccount({
      refreshToken: 'ref-2',
      projectId: 'p-2',
      email: 'acc2@gmail.com',
    })
    const acc3 = await pool.addOrUpdateAccount({
      refreshToken: 'ref-3',
      projectId: 'p-3',
      email: 'acc3@gmail.com',
    })
    const acc4 = await pool.addOrUpdateAccount({
      refreshToken: 'ref-4',
      projectId: 'p-4',
      email: 'acc4@gmail.com',
    })

    await pool.switchAccount(acc1.id)

    // acc1: 0.08 (<= 10%)
    // acc2: 0.45 (45%)
    // acc3: 0.85 (85%) -> highest healthy quota!
    // acc4: 0.05 (5% exhausted)
    vi.spyOn(pool, 'checkAccountQuota').mockImplementation(async (account: AccountPoolItem) => {
      if (account.id === acc1.id) {
        return { remainingFraction: 0.08, checkedAt: new Date().toISOString(), state: 'available' }
      }
      if (account.id === acc2.id) {
        return { remainingFraction: 0.45, checkedAt: new Date().toISOString(), state: 'available' }
      }
      if (account.id === acc3.id) {
        return { remainingFraction: 0.85, checkedAt: new Date().toISOString(), state: 'available' }
      }
      return { remainingFraction: 0.05, checkedAt: new Date().toISOString(), state: 'available' }
    })

    const result = await pool.checkQuotasAndAutoSwitch(false)
    expect(result.switched).toBe(true)
    expect(result.previousAccountId).toBe(acc1.id)
    expect(result.currentAccountId).toBe(acc3.id)
    expect((await pool.getActiveAccount())?.id).toBe(acc3.id)
  })

  it('switches when active quota is exactly 0.10 (10%) and does not switch when 0.101', async () => {
    const pool = createAccountPool({ isMemory: true })
    const acc1 = await pool.addOrUpdateAccount({
      refreshToken: 'ref-1',
      projectId: 'p-1',
      email: 'border-1@gmail.com',
    })
    const acc2 = await pool.addOrUpdateAccount({
      refreshToken: 'ref-2',
      projectId: 'p-2',
      email: 'border-2@gmail.com',
    })

    // Test case 1: 0.101 -> above 10%, no switch
    await pool.switchAccount(acc1.id)
    vi.spyOn(pool, 'checkAccountQuota').mockImplementation(async (account: AccountPoolItem) => {
      if (account.id === acc1.id) {
        return { remainingFraction: 0.101, checkedAt: new Date().toISOString(), state: 'available' }
      }
      return { remainingFraction: 0.90, checkedAt: new Date().toISOString(), state: 'available' }
    })

    let result = await pool.checkQuotasAndAutoSwitch(false)
    expect(result.switched).toBe(false)
    expect((await pool.getActiveAccount())?.id).toBe(acc1.id)

    // Test case 2: 0.10 -> exactly 10%, triggers switch
    vi.spyOn(pool, 'checkAccountQuota').mockImplementation(async (account: AccountPoolItem) => {
      if (account.id === acc1.id) {
        return { remainingFraction: 0.10, checkedAt: new Date().toISOString(), state: 'available' }
      }
      return { remainingFraction: 0.90, checkedAt: new Date().toISOString(), state: 'available' }
    })

    result = await pool.checkQuotasAndAutoSwitch(false)
    expect(result.switched).toBe(true)
    expect(result.currentAccountId).toBe(acc2.id)
    expect((await pool.getActiveAccount())?.id).toBe(acc2.id)
  })

  it('starts and stops scheduler cleanly without unhandled errors', async () => {
    const pool = createAccountPool({ isMemory: true })
    pool.startScheduler()
    // Starting twice should be a no-op
    pool.startScheduler()
    pool.stopScheduler()
    // Stopping twice should be a no-op
    pool.stopScheduler()
    await pool.dispose()
  })
})
