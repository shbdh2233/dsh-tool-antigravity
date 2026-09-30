/** Host dispatcher protected by the Antigravity account RPC activation guard. */

import type { ConnectionRpcResult as RpcResult } from '@deepseek-ai/dsh-client-connection'
import { OAuthFlowError } from './oauth-flow.ts'
import { CredentialOperationError, credentialErrorMessage } from './credential-coordinator.ts'
import type { BootstrapStatusService } from './status.ts'
import type { QuotaStatusView } from './quota.ts'
import { isSafeRpcErrorCode, safeRpcErrorMessage } from './rpc-vocabulary.ts'
import type { AntigravityModelCatalogService } from './model-catalog.ts'
import { getStoredProxy, setStoredProxy, applyProxySetting } from './proxy-config.ts'
export { ANTIGRAVITY_AUTH_RPC_CHANNEL, ANTIGRAVITY_AUTH_RPC_NAMESPACE } from './rpc-contract.ts'

export type AntigravityAuthRpcService = Pick<
  BootstrapStatusService,
  'status' | 'acknowledgeRisk' | 'startLogin' | 'cancelLogin' | 'logout' | 'revoke'
> & {
  usage?: (signal?: AbortSignal, force?: boolean) => Promise<QuotaStatusView>
  poolStatus?: () => Promise<import('./account-pool.ts').AccountPoolStatusView>
  switchAccount?: (id: string) => Promise<import('./account-pool.ts').AccountPoolItem | undefined>
  removeAccount?: (id: string) => Promise<boolean>
  updatePoolConfig?: (config: Partial<import('./account-pool.ts').AccountPoolConfig>) => Promise<import('./account-pool.ts').AccountPoolConfig>
  checkQuotas?: (forceAll?: boolean) => Promise<{
    readonly switched: boolean
    readonly previousAccountId?: string
    readonly currentAccountId?: string
    readonly reason?: string
  }>
}

/** Dispatch closed, value-safe requests; callback URLs are never echoed. */
export async function handleAntigravityAuthRpc(
  service: AntigravityAuthRpcService,
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
  modelCatalog?: AntigravityModelCatalogService,
): Promise<RpcResult<unknown>> {
  if (signal?.aborted === true) return cancelled()

  try {
    if (endpoint === 'status') {
      if (!isEmptyRecord(payload)) return badRequest('status expects an empty payload')
      return { ok: true, value: { status: await service.status() } }
    }
    if (endpoint === 'models') {
      if (!isRefreshPayload(payload)) return badRequest('models expects {} or { force: boolean }')
      if (modelCatalog === undefined) return badRequest('model catalog is unavailable')
      const status = await service.status()
      const gateReady = status.login.projectAvailable
        && status.capabilities.some(capability => capability.id === 'auth-llm' && capability.state === 'available')
      return { ok: true, value: gateReady
        ? await modelCatalog.modelCatalog(signal, payload.force)
        : modelCatalog.catalogSnapshot() }
    }
    if (endpoint === 'usage') {
      if (!isRefreshPayload(payload)) return badRequest('usage expects {} or { force: boolean }')
      if (service.usage === undefined) return { ok: true, value: { state: 'protocol-drift' as const } }
      return { ok: true, value: await service.usage(signal, payload.force) }
    }
    if (endpoint === 'acknowledge-risk') {
      if (!isAcknowledgement(payload)) return badRequest('acknowledge-risk expects { acknowledge: true }')
      return { ok: true, value: await service.acknowledgeRisk() }
    }
    if (endpoint === 'login') {
      if (!isEmptyRecord(payload)) return badRequest('login expects an empty payload')
      return { ok: true, value: await service.startLogin() }
    }
    if (endpoint === 'cancel' || endpoint === 'cancel-login') {
      if (!isEmptyRecord(payload)) return badRequest('cancel expects an empty payload')
      return { ok: true, value: await service.cancelLogin() }
    }
    if (endpoint === 'logout') {
      if (!isEmptyRecord(payload)) return badRequest('logout expects an empty payload')
      return { ok: true, value: await service.logout() }
    }
    if (endpoint === 'revoke') {
      if (!isRevokePayload(payload)) return badRequest('revoke expects { confirmed: true }')
      return { ok: true, value: await service.revoke(true, signal) }
    }
    if (endpoint === 'get-proxy') {
      return { ok: true, value: { proxy: getStoredProxy() } }
    }
    if (endpoint === 'set-proxy') {
      const proxy = isRecord(payload) && typeof payload.proxy === 'string' ? payload.proxy.trim() : ''
      setStoredProxy(proxy)
      applyProxySetting(proxy)
      return { ok: true, value: { proxy } }
    }
    if (endpoint === 'accounts') {
      if (!isEmptyRecord(payload)) return badRequest('accounts expects an empty payload')
      if (service.poolStatus === undefined) {
        return { ok: true, value: { pool: { accounts: [], config: { autoSwitch: true, quotaThreshold: 0.1, checkIntervalSeconds: 120 } } } }
      }
      return { ok: true, value: { pool: await service.poolStatus() } }
    }
    if (endpoint === 'switch-account') {
      if (!isRecord(payload) || typeof payload.id !== 'string' || !payload.id.trim()) {
        return badRequest('switch-account expects { id: string }')
      }
      if (service.switchAccount === undefined) return badRequest('pool is unavailable')
      const target = await service.switchAccount(payload.id.trim())
      return { ok: true, value: { activeAccountId: target?.id ?? payload.id, switched: target !== undefined } }
    }
    if (endpoint === 'remove-account') {
      if (!isRecord(payload) || typeof payload.id !== 'string' || !payload.id.trim()) {
        return badRequest('remove-account expects { id: string }')
      }
      if (service.removeAccount === undefined) return badRequest('pool is unavailable')
      const removed = await service.removeAccount(payload.id.trim())
      return { ok: true, value: { removed } }
    }
    if (endpoint === 'set-pool-config') {
      if (!isRecord(payload)) return badRequest('set-pool-config expects an object')
      if (service.updatePoolConfig === undefined) return badRequest('pool is unavailable')
      const patch: Record<string, unknown> = {}
      if (typeof payload.autoSwitch === 'boolean') patch.autoSwitch = payload.autoSwitch
      if (typeof payload.quotaThreshold === 'number') patch.quotaThreshold = payload.quotaThreshold
      if (typeof payload.checkIntervalSeconds === 'number') patch.checkIntervalSeconds = payload.checkIntervalSeconds
      const config = await service.updatePoolConfig(patch)
      return { ok: true, value: { config } }
    }
    if (endpoint === 'check-pool-quotas') {
      const forceAll = isRecord(payload) && typeof payload.forceAll === 'boolean' ? payload.forceAll : false
      if (service.checkQuotas === undefined) return { ok: true, value: { switched: false } }
      const res = await service.checkQuotas(forceAll)
      const pool = service.poolStatus ? await service.poolStatus() : undefined
      return { ok: true, value: { pool, switched: res.switched, reason: res.reason } }
    }
    return badRequest('unknown Antigravity auth endpoint')
  } catch (error) {
    return safeFailure(error)
  }
}

function badRequest(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function cancelled(): RpcResult<never> {
  return { ok: false, error: { code: 'cancelled', message: 'antigravity-auth: request cancelled', details: {} } }
}

function safeFailure(error: unknown): RpcResult<never> {
  const credentialError = error instanceof CredentialOperationError ? error : undefined
  const candidate = error instanceof OAuthFlowError
    ? error.code
    : credentialError?.code ?? 'internal'
  const code = isSafeRpcErrorCode(candidate) ? candidate : 'internal'
  return {
    ok: false,
    error: {
      code: code as never,
      message: credentialError === undefined
        ? safeRpcErrorMessage(code)
        : credentialErrorMessage(credentialError.code) ?? safeRpcErrorMessage(code),
      details: {},
    },
  }
}

function isEmptyRecord(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0
}

function isRefreshPayload(value: unknown): value is { force?: boolean } {
  return isRecord(value)
    && Object.keys(value).every(key => key === 'force')
    && (value.force === undefined || typeof value.force === 'boolean')
}

function isAcknowledgement(value: unknown): value is { acknowledge: true } {
  return isRecord(value)
    && Object.keys(value).length === 1
    && value.acknowledge === true
}

function isRevokePayload(value: unknown): value is { confirmed: true } {
  return isRecord(value)
    && Object.keys(value).length === 1
    && value.confirmed === true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
