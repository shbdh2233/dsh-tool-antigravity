/** Settings shell for value-safe Antigravity login status. */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { AntigravityAuthRpcClient } from '../rpc-contract.ts'
import type { QuotaStatusView } from '../quota.ts'
import type { AntigravityImageSettings } from '../image.ts'
import type { RevokeState } from '../credential-coordinator.ts'
import type { AccountPoolStatusView } from '../account-pool.ts'
import type {
  AntigravityStatusView,
  CapabilityRowId,
  LoginErrorCode,
} from '../status.ts'
import type { AntigravityAuthKey } from './locales.ts'
import { ensureSettingsStyles } from './styles.ts'

export interface AntigravityAuthSettingsProps {
  rpc: AntigravityAuthRpcClient
  t: (key: AntigravityAuthKey) => string
  subscribe: (listener: () => void) => () => void
  imageScope?: SettingsScope<AntigravityImageSettings> | undefined
}

type LoadState = 'loading' | 'ready' | 'error'
type BooleanSettings = { readonly enabled: boolean }
type SettingsSnapshot = ReturnType<SettingsScope<BooleanSettings>['getSnapshot']>
const EMPTY_SETTINGS_SNAPSHOT: SettingsSnapshot = { status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'memory' }

function useCapabilitySettings<T extends BooleanSettings>(scope: SettingsScope<T> | undefined): SettingsSnapshot & { readonly value: T | undefined } {
  const subscribe = useCallback((listener: () => void) => scope?.subscribe(listener) ?? (() => {}), [scope])
  const getSnapshot = useCallback(() => scope?.getSnapshot() ?? EMPTY_SETTINGS_SNAPSHOT, [scope])
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SETTINGS_SNAPSHOT) as SettingsSnapshot & { readonly value: T | undefined }
}

function useUnmountSignal(): () => AbortSignal {
  const controller = useRef(new AbortController())
  useEffect(() => {
    const active = new AbortController()
    controller.current = active
    return () => active.abort()
  }, [])
  return useCallback(() => controller.current.signal, [])
}

/** One navigable settings section; credentials remain Host-only and actions use typed RPC. */
export function AntigravityAuthSettings({ rpc, t, subscribe, imageScope }: AntigravityAuthSettingsProps): ReactNode {
  const [status, setStatus] = useState<AntigravityStatusView | null>(null)
  const imageSettings = useCapabilitySettings(imageScope)
  const [quota, setQuota] = useState<QuotaStatusView | null>(null)
  const [quotaBusy, setQuotaBusy] = useState(false)
  const [quotaError, setQuotaError] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [_error, setError] = useState<string | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [proxyInput, setProxyInput] = useState('')
  const [proxySaving, setProxySaving] = useState(false)
  const [proxyMessage, setProxyMessage] = useState('')
  const [pool, setPool] = useState<AccountPoolStatusView | null>(null)
  const [poolBusy, setPoolBusy] = useState(false)
  const [poolMessage, setPoolMessage] = useState<string | null>(null)
  const [resetTick, setResetTick] = useState(0)
  const statusGeneration = useRef(0)
  const quotaGeneration = useRef(0)
  const unmountSignal = useUnmountSignal()

  useEffect(() => {
    ensureSettingsStyles()
  }, [])

  useEffect(() => subscribe(() => { setResetTick(value => value + 1) }), [subscribe])

  useEffect(() => {
    let active = true
    rpc.getProxy?.().then(res => {
      if (active && res?.ok && typeof res.value?.proxy === 'string') {
        setProxyInput(res.value.proxy)
      }
    })
    return () => { active = false }
  }, [rpc])

  const saveProxy = async (): Promise<void> => {
    setProxySaving(true)
    try {
      const trimmed = proxyInput.trim()
      const res = await rpc.setProxy?.(trimmed)
      if (res?.ok) {
        setProxyMessage(trimmed ? `${t('proxySaved')}${trimmed}` : t('proxyCleared'))
      } else {
        setProxyMessage(`${t('saveProxyFailed')}${res?.error?.message ?? ''}`)
      }
      setTimeout(() => setProxyMessage(''), 4000)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setProxyMessage(`${t('saveProxyFailed')}${message}`)
    } finally {
      setProxySaving(false)
    }
  }
  const load = useCallback(async (signal?: AbortSignal, silent = false) => {
    const generation = ++statusGeneration.current
    if (!silent) {
      setLoadState(prev => (prev === 'ready' ? 'ready' : 'loading'))
      setError(null)
    }
    try {
      const result = await rpc.status(signal)
      if (signal?.aborted === true || generation !== statusGeneration.current) return
      if (!result.ok) {
        setLoadState('error')
        setError(result.error.message || t('statusFailed'))
        return
      }
      setStatus(result.value.status)
      setLoadState('ready')
    } catch (cause) {
      if (signal?.aborted === true || generation !== statusGeneration.current) return
      setLoadState('error')
      setError(messageOf(cause, t('statusFailed')))
    }
  }, [rpc, t])

  const loadQuota = useCallback(async (force = false, signal?: AbortSignal) => {
    if (rpc.usage === undefined) return
    const generation = ++quotaGeneration.current
    setQuotaBusy(true)
    setQuotaError(null)
    try {
      const result = await rpc.usage(signal, force)
      if (signal?.aborted === true || generation !== quotaGeneration.current) return
      if (!result.ok) {
        setQuotaError(result.error.message || t('quotaFailed'))
        return
      }
      setQuota(result.value)
    } catch (cause) {
      if (signal?.aborted === true || generation !== quotaGeneration.current) return
      setQuotaError(messageOf(cause, t('quotaFailed')))
    } finally {
      if (signal?.aborted !== true && generation === quotaGeneration.current) setQuotaBusy(false)
    }
  }, [rpc, t])

  useEffect(() => {
    if (status?.login.projectAvailable !== true || rpc.usage === undefined) {
      setQuota(null)
      return
    }
    const controller = new AbortController()
    void loadQuota(false, controller.signal)
    return () => controller.abort()
  }, [loadQuota, rpc.usage, status?.login.projectAvailable, resetTick])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, resetTick])

  useEffect(() => {
    if (status?.login.phase !== 'pending') return
    const controller = new AbortController()
    const timer = globalThis.setInterval(() => { void load(controller.signal, true) }, 1_000)
    return () => {
      globalThis.clearInterval(timer)
      controller.abort()
    }
  }, [load, status?.login.phase])

  const startLogin = useCallback(async () => {
    const signal = unmountSignal()
    setLoginBusy(true)
    setError(null)
    try {
      if (status?.riskAcknowledged !== true) {
        await rpc.acknowledgeRisk(signal)
      }
      const result = await rpc.login(signal)
      if (signal.aborted) return
      if (!result.ok) {
        setError(result.error.message || t('loginFailed'))
        await load(signal)
        return
      }
      setStatus(previous => {
        if (previous === null) return previous
        const { errorCode: _ignoredErrorCode, ...login } = previous.login
        return {
          ...previous,
          riskAcknowledged: true,
          login: {
            ...login,
            phase: 'pending',
            authorizationUrl: result.value.authorizationUrl,
            expiresAt: result.value.expiresAt,
          },
        }
      })
    } catch (cause) {
      if (!signal.aborted) setError(messageOf(cause, t('loginFailed')))
    } finally {
      if (!signal.aborted) setLoginBusy(false)
    }
  }, [load, rpc, status?.riskAcknowledged, t, unmountSignal])

  const cancelLogin = useCallback(async () => {
    const signal = unmountSignal()
    setLoginBusy(true)
    setError(null)
    try {
      const result = await rpc.cancelLogin(signal)
      if (signal.aborted) return
      if (!result.ok) {
        setError(result.error.message || t('cancelLoginFailed'))
        return
      }
      setStatus(previous => {
        if (previous === null) return previous
        const { errorCode: _ignoredErrorCode, ...login } = previous.login
        return {
          ...previous,
          login: result.value.errorCode === undefined
            ? { ...login, phase: result.value.phase }
            : { ...login, phase: result.value.phase, errorCode: result.value.errorCode },
        }
      })
    } catch (cause) {
      if (!signal.aborted) setError(messageOf(cause, t('cancelLoginFailed')))
    } finally {
      if (!signal.aborted) setLoginBusy(false)
    }
  }, [rpc, t, unmountSignal])

  const logout = useCallback(async () => {
    const signal = unmountSignal()
    setActionBusy(true)
    setError(null)
    try {
      const result = await rpc.logout(signal)
      if (signal.aborted) return
      if (!result.ok) {
        setError(result.error.message || t('logoutFailed'))
        return
      }
      await load(signal)
    } catch (cause) {
      if (!signal.aborted) setError(messageOf(cause, t('logoutFailed')))
    } finally {
      if (!signal.aborted) setActionBusy(false)
    }
  }, [load, rpc, t, unmountSignal])

  const loadPool = useCallback(async (signal?: AbortSignal) => {
    if (rpc.getAccounts === undefined) return
    try {
      const res = await rpc.getAccounts(signal)
      if (res.ok && res.value?.pool) {
        setPool(res.value.pool)
      }
    } catch {}
  }, [rpc])

  useEffect(() => {
    if (status?.login.configured === true) {
      void loadPool(unmountSignal())
    }
  }, [status?.login.configured, loadPool, unmountSignal, resetTick])

  const onSwitchAccount = async (id: string): Promise<void> => {
    if (!rpc.switchAccount) return
    setPoolBusy(true)
    try {
      const res = await rpc.switchAccount(id, unmountSignal())
      if (res.ok) {
        setPoolMessage(t('switchedAccountSuccess'))
        await Promise.all([load(unmountSignal(), true), loadPool(unmountSignal()), loadQuota(true, unmountSignal())])
      }
      setTimeout(() => setPoolMessage(null), 3000)
    } finally {
      setPoolBusy(false)
    }
  }

  const onRemoveAccount = async (id: string): Promise<void> => {
    if (!rpc.removeAccount) return
    setPoolBusy(true)
    try {
      const res = await rpc.removeAccount(id, unmountSignal())
      if (res.ok) {
        setPoolMessage(t('removedAccountSuccess'))
        await Promise.all([load(unmountSignal(), true), loadPool(unmountSignal()), loadQuota(true, unmountSignal())])
      }
      setTimeout(() => setPoolMessage(null), 3000)
    } finally {
      setPoolBusy(false)
    }
  }

  const onToggleAutoSwitch = async (enabled: boolean): Promise<void> => {
    if (!rpc.setPoolConfig) return
    try {
      const res = await rpc.setPoolConfig({ autoSwitch: enabled }, unmountSignal())
      if (res.ok) {
        await loadPool(unmountSignal())
      }
    } catch {}
  }

  const onCheckAllQuotas = async (): Promise<void> => {
    if (!rpc.checkPoolQuotas) return
    setPoolBusy(true)
    try {
      const res = await rpc.checkPoolQuotas(true, unmountSignal())
      if (res.ok) {
        if (res.value?.switched) {
          setPoolMessage(res.value.reason || t('switchedAccountSuccess'))
          await Promise.all([load(unmountSignal(), true), loadPool(unmountSignal()), loadQuota(true, unmountSignal())])
        } else {
          await loadPool(unmountSignal())
        }
      }
      setTimeout(() => setPoolMessage(null), 4000)
    } finally {
      setPoolBusy(false)
    }
  }

  const projectError = projectErrorText(status?.login.errorCode, t)
  const isConfigured = status?.login.configured === true

  return (
    <section className="agy-settings" data-plugin="dsh-tool-antigravity" aria-labelledby="antigravity-auth-title">
      <header className="agy-bundle-header">
        <div>
          <div className="agy-title-line">
            <h1 id="antigravity-auth-title" className="agy-bundle-title">{t('title')}</h1>
            {isConfigured ? (
              <span className="agy-status-dot" role="status" aria-label={t('ready')} />
            ) : null}
          </div>
          <p className="agy-bundle-intro">{t('intro')}</p>
        </div>
      </header>

      <div className="agy-cards">
        {/* Card 1: Auth & Quota */}
        <article className="agy-card" aria-labelledby="antigravity-auth-card-title">
          <div className="agy-card-header">
            <div className="agy-card-identity">
              <h2 id="antigravity-auth-card-title" className="agy-card-title">{t('authCardTitle')}</h2>
              <p className="agy-card-intro">{t('authCardIntro')}</p>
            </div>
          </div>

          <QuotaVisualDashboard
            quota={quota}
            busy={quotaBusy}
            error={quotaError}
            onRefresh={() => { void loadQuota(true, unmountSignal()) }}
            t={t}
          />

          <div className="agy-action-row">
            {status?.login.phase === 'pending' && typeof status.login.authorizationUrl === 'string' ? (
              <>
                <a className="agy-btn agy-btn-primary" href={status.login.authorizationUrl} target="_blank" rel="noreferrer">
                  {t('openAuthorization')}
                </a>
                <button className="agy-btn agy-btn-outline" type="button" disabled={loginBusy} onClick={() => { void cancelLogin() }}>
                  {t('cancelLogin')}
                </button>
              </>
            ) : (
              <button className="agy-btn agy-btn-primary" type="button" disabled={status === null || loginBusy} onClick={() => { void startLogin() }}>
                {loginBusy ? t('startingLogin') : isConfigured ? t('relogin') : t('login')}
              </button>
            )}

            {status?.credential?.configured ? (
              <button className="agy-btn agy-btn-outline" type="button" disabled={actionBusy} onClick={() => { void logout() }}>
                {t('logout')}
              </button>
            ) : null}

            <button
              className="agy-btn agy-btn-ghost agy-refresh-btn"
              type="button"
              disabled={loadState === 'loading' || quotaBusy}
              onClick={() => {
                const minDelay = new Promise(resolve => setTimeout(resolve, 500))
                void Promise.all([load(unmountSignal()), loadQuota(true, unmountSignal()), minDelay])
              }}
            >
              <span className={quotaBusy || loadState === 'loading' ? 'agy-spin-icon' : ''}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>
              </span>
              {quotaBusy || loadState === 'loading' ? t('queryingQuota') : t('refreshStatus')}
            </button>
          </div>
          <p className="agy-footer-notice">{t('quotaFooterNotice')}</p>

          {status?.login.phase === 'expired' ? <p className="agy-alert" role="alert">{t('loginExpired')}</p> : null}
          {status?.login.phase === 'port-conflict' ? <p className="agy-alert" role="alert">{t('loginPortConflict')}</p> : null}
          {status?.login.phase === 'failed' ? <p className="agy-alert" role="alert">{t('loginFailed')}</p> : null}
          {projectError === undefined ? null : <p className="agy-alert" role="alert">{projectError}</p>}
          {status?.login.phase === 'pending' && status.login.expiresAt !== undefined ? (
            <p className="agy-card-subtext">{t('expiresAt')}: <time dateTime={status.login.expiresAt}>{status.login.expiresAt}</time></p>
          ) : null}
          {status?.revoke === undefined || status.revoke.state === 'idle' ? null : (
            <p className="agy-card-subtext" role="status">{revokeStatusText(status.revoke.state, t)}</p>
          )}
        </article>

        {/* Card 2: Account Pool & Quota Auto-Switch (rendered when configured) */}
        {isConfigured ? (
          <article className="agy-card" aria-labelledby="antigravity-pool-card-title">
            <div className="agy-card-header">
              <div className="agy-card-identity">
                <h2 id="antigravity-pool-card-title" className="agy-card-title">{t('poolCardTitle')}</h2>
                <p className="agy-card-intro">{t('poolCardIntro')}</p>
              </div>
            </div>

            <div className="agy-pool-list">
              {pool && pool.accounts.length > 0 ? (
                pool.accounts.map(acc => {
                  return (
                    <div key={acc.id} className="agy-pool-item" data-active={acc.isActive}>
                      <div className="agy-pool-item-meta">
                        <span className="agy-pool-badge" data-active={acc.isActive}>
                          {acc.isActive ? t('activeAccountBadge') : t('standbyAccountBadge')}
                        </span>
                        <span className="agy-pool-item-email">{acc.email || acc.id}</span>
                      </div>
                      {acc.quota ? (
                        <div className="agy-pool-item-quota">
                          {acc.quota.windowWeeklyFraction !== undefined ? (
                            <QuotaRing
                              label={t('poolQuotaWeekly')}
                              fraction={acc.quota.windowWeeklyFraction}
                              tone={quotaTone(acc.quota.windowWeeklyFraction)}
                            />
                          ) : null}
                          {acc.quota.window5hFraction !== undefined ? (
                            <QuotaRing
                              label={t('poolQuota5h')}
                              fraction={acc.quota.window5hFraction}
                              tone={quotaTone(acc.quota.window5hFraction)}
                            />
                          ) : null}
                        </div>
                      ) : null}
                      <div className="agy-pool-item-actions">
                        {!acc.isActive ? (
                          <button
                            className="agy-btn agy-btn-outline"
                            type="button"
                            disabled={poolBusy}
                            onClick={() => { void onSwitchAccount(acc.id) }}
                            style={{ padding: '3px 8px', fontSize: '12px' }}
                          >
                            {t('switchAccount')}
                          </button>
                        ) : null}
                        <button
                          className="agy-btn agy-btn-ghost"
                          type="button"
                          disabled={poolBusy}
                          onClick={() => { void onRemoveAccount(acc.id) }}
                          style={{ padding: '3px 8px', fontSize: '12px', color: '#ef4444' }}
                        >
                          {t('removeAccount')}
                        </button>
                      </div>
                    </div>
                  )
                })
              ) : (
                <p className="agy-card-subtext">{t('noAccountsInPool')}</p>
              )}
            </div>

            <div className="agy-pool-toggle-row">
              <div>
                <span style={{ fontWeight: 500, color: 'var(--dsw-alias-label-primary, #e6edf3)' }}>
                  {t('autoSwitchToggle')}
                </span>
                <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #8b949e)' }}>
                  {t('autoSwitchActive')}
                </p>
              </div>
              <Switch
                label={t('autoSwitchToggle')}
                checked={pool?.config?.autoSwitch ?? true}
                onChange={next => { void onToggleAutoSwitch(next) }}
              />
            </div>

            <div className="agy-action-row" style={{ marginTop: '4px' }}>
              <button
                className="agy-btn agy-btn-outline"
                type="button"
                disabled={loginBusy || poolBusy}
                onClick={() => { void startLogin() }}
              >
                {t('addAccount')}
              </button>
              <button
                className="agy-btn agy-btn-outline"
                type="button"
                disabled={poolBusy}
                onClick={() => { void onCheckAllQuotas() }}
              >
                {poolBusy ? t('checkingQuotas') : t('checkAllQuotas')}
              </button>
            </div>

            {poolMessage ? (
              <p className="agy-card-subtext" style={{ color: '#10b981', margin: '2px 0 0' }}>
                {poolMessage}
              </p>
            ) : null}
          </article>
        ) : null}

        {/* Card 2: Network Proxy */}
        <article className="agy-card">
          <div className="agy-card-header">
            <div className="agy-card-identity">
              <h2 className="agy-card-title">{t('proxyCardTitle')}</h2>
              <p className="agy-card-intro">{t('proxyCardIntro')}</p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' }}>
            <input
              type="text"
              placeholder={t('proxyPlaceholder')}
              value={proxyInput}
              onChange={e => setProxyInput(e.target.value)}
              style={{
                flex: 1,
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.16)',
                borderRadius: '6px',
                color: '#ffffff',
                padding: '6px 10px',
                fontSize: '13px',
                outline: 'none',
              }}
            />
            <button
              className="agy-btn agy-btn-outline"
              type="button"
              disabled={proxySaving}
              onClick={() => { void saveProxy() }}
            >
              {proxySaving ? t('savingProxy') : t('saveProxy')}
            </button>
          </div>
          {proxyMessage ? (
            <p
              className="agy-card-subtext"
              style={{ color: proxyMessage.startsWith(t('saveProxyFailed')) ? '#ef4444' : '#10b981', margin: '2px 0 0' }}
            >
              {proxyMessage}
            </p>
          ) : null}
        </article>

        {/* Card 3: Image Creation */}
        <article className="agy-card">
          <div className="agy-card-header">
            <div className="agy-card-identity">
              <h2 className="agy-card-title">{t('image')}</h2>
              <p className="agy-card-intro">{t('imageCardIntro')}</p>
            </div>
            <div className="agy-card-action">
              <Switch
                label={t('toggleImage')}
                checked={imageSettings.value?.enabled ?? false}
                disabled={!capabilityAvailable(status, 'image') || imageSettings.status !== 'ready' || !imageSettings.writable}
                onChange={next => { void imageScope?.set('enabled', next) }}
              />
            </div>
          </div>
        </article>

      </div>
    </section>
  )
}

function capabilityAvailable(status: AntigravityStatusView | null, id: CapabilityRowId): boolean {
  return status?.login.projectAvailable === true && status.capabilities.some(capability => capability.id === id && capability.state === 'available')
}

function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  readonly label: string
  readonly checked: boolean
  readonly disabled?: boolean
  readonly onChange: (checked: boolean) => void
}): ReactNode {
  return (
    <label className="agy-switch">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={e => { onChange(e.target.checked) }}
      />
      <span className="agy-switch-slider" />
    </label>
  )
}

function QuotaRing({
  label,
  fraction,
  tone,
}: {
  readonly label: string
  readonly fraction: number
  readonly tone: 'normal' | 'warning' | 'error'
}): ReactNode {
  const radius = 13
  const strokeWidth = 3
  const circumference = 2 * Math.PI * radius
  const validFraction = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  const offset = circumference * (1 - validFraction)
  const pct = Math.round(validFraction * 100)

  return (
    <div className="agy-pool-ring-group" title={`${label}: ${(validFraction * 100).toFixed(1)}%`}>
      <span className="agy-pool-ring-label">{label}</span>
      <div className="agy-pool-ring-wrapper">
        <svg className="agy-pool-ring-svg" viewBox="0 0 32 32">
          <circle
            className="agy-pool-ring-bg"
            cx="16"
            cy="16"
            r={radius}
            strokeWidth={strokeWidth}
          />
          <circle
            className="agy-pool-ring-fg"
            data-tone={tone}
            cx="16"
            cy="16"
            r={radius}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
        </svg>
      </div>
      <span className="agy-pool-ring-pct" data-tone={tone}>{pct}%</span>
    </div>
  )
}

function formatRefreshTime(resetTime: string, dayUnit: string, now = Date.now()): string {
  const target = new Date(resetTime).getTime()
  if (Number.isNaN(target)) return resetTime
  const diffMs = target - now
  if (diffMs <= 0) return '0m'
  const diffMinutes = Math.floor(diffMs / (60 * 1000))
  const hours = Math.floor(diffMinutes / 60)
  const remMinutes = diffMinutes % 60

  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    return `${days}${dayUnit} ${hours % 24}h ${remMinutes}m`
  }
  if (hours > 0) {
    return `${hours}h ${remMinutes}m`
  }
  return `${remMinutes}m`
}

function quotaTone(fraction: number): 'normal' | 'warning' | 'error' {
  if (fraction < 0.3) return 'error'
  if (fraction <= 0.6) return 'warning'
  return 'normal'
}

function QuotaVisualDashboard({
  quota,
  busy,
  error,
  t,
}: {
  readonly quota: QuotaStatusView | null
  readonly busy?: boolean
  readonly error: string | null
  readonly onRefresh?: () => void
  readonly t: AntigravityAuthSettingsProps['t']
}): ReactNode {
  return (
    <div className="agy-quota-section">
      {quota?.state === 'available' && quota.groups !== undefined && quota.groups.length > 0 ? (
        <div className="agy-quota-groups">
          {quota.groups.map(group => {
            const groupTitle = group.group === 'gemini' ? t('geminiGroupTitle') : t('claudeGptGroupTitle')
            const groupDesc = group.group === 'gemini' ? t('geminiGroupDesc') : t('claudeGptGroupDesc')
            return (
              <div key={group.group} className="agy-quota-group">
                <div className="agy-quota-group-header">
                  <span className="agy-quota-group-title">{groupTitle}</span>
                  <span className="agy-quota-group-desc">{groupDesc}</span>
                </div>
                <div className="agy-quota-buckets">
                  {group.windows.map(window => {
                    const windowName = window.window === '5h' ? t('window5hTitle') : t('windowWeeklyTitle')
                    const pctFormatted = (window.remainingFraction * 100).toFixed(2) + '%'
                    const pctRounded = Math.round(window.remainingFraction * 100)
                    const refreshStr = formatRefreshTime(window.resetTime, t('quotaDayUnit'))
                    const subtext = `${pctRounded}% ${t('remaining')} · ${t('refreshesIn').replace('{time}', refreshStr)}`
                    const widthPct = Math.max(0, Math.min(100, window.remainingFraction * 100))
                    const tone = quotaTone(window.remainingFraction)

                    return (
                      <div key={window.window} className="agy-quota-bucket">
                        <div className="agy-quota-bucket-head">
                          <span className="agy-quota-bucket-name">{windowName}</span>
                          {busy ? (
                            <span className="agy-quota-querying">
                              <span className="agy-querying-spinner" aria-hidden="true" />
                              <span>{t('queryingQuota')}</span>
                            </span>
                          ) : (
                            <span className="agy-quota-bucket-val" data-tone={tone}>{pctFormatted}</span>
                          )}
                        </div>
                        <div className="agy-progress-track">
                          {busy ? (
                            <div className="agy-shimmer-track" aria-hidden="true" />
                          ) : (
                            <div className="agy-progress-bar" data-tone={tone} style={{ width: `${widthPct}%` }} />
                          )}
                        </div>
                        <span className="agy-quota-subtext">{subtext}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
      {error === null ? null : <p className="agy-alert" role="alert">{error}</p>}
    </div>
  )
}

const PROJECT_ERROR_KEYS: Readonly<Partial<Record<LoginErrorCode, AntigravityAuthKey>>> = {
  'project-unavailable': 'projectUnavailable',
  'project-authentication-failed': 'projectAuthenticationFailed',
  'project-forbidden': 'projectForbidden',
  'project-rate-limited': 'projectRateLimited',
  'project-offline': 'projectOffline',
  'project-malformed': 'projectMalformed',
  'project-protocol-drift': 'projectProtocolDrift',
}
const REVOKE_STATE_KEYS: Readonly<Record<RevokeState, AntigravityAuthKey>> = {
  idle: 'credentialLoggedOut',
  'logged-out': 'credentialLoggedOut',
  pending: 'revokePending',
  revoked: 'revokeSuccess',
  failed: 'revokeFailed',
  superseded: 'revokeSuperseded',
  'confirmation-required': 'revokeConfirmationRequired',
}

function projectErrorText(errorCode: LoginErrorCode | undefined, t: AntigravityAuthSettingsProps['t']): string | undefined {
  if (errorCode === undefined) return undefined
  const key = PROJECT_ERROR_KEYS[errorCode]
  return key === undefined ? undefined : t(key)
}

function revokeStatusText(state: RevokeState, t: AntigravityAuthSettingsProps['t']): string {
  return t(REVOKE_STATE_KEYS[state])
}

function messageOf(_error: unknown, fallback: string): string {
  return fallback
}
