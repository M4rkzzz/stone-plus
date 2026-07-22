import { useEffect, useState } from 'react'
import type { AppSnapshot, GatewayApi } from '@shared/types'

export const BUILT_IN_PROXY_TAKEOVER_NOTICE = {
  zh: '内置代理接管中，关闭后恢复',
  en: 'The built-in proxy is in control. This setting will resume after it is disabled.',
} as const

export const BUILT_IN_PROXY_BINDING_NOTICE = {
  zh: '绑定已保留，关闭内置代理后恢复',
  en: 'The binding is preserved and will resume after the built-in proxy is disabled.',
} as const

type UnknownRecord = Record<string, unknown>

interface BuiltInProxyApiLike {
  getBuiltInProxyState?: () => Promise<unknown>
  onBuiltInProxyState?: (listener: (state: unknown) => void) => void | (() => void)
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : undefined
}

function runtimeFromSnapshot(snapshot: AppSnapshot): unknown {
  const value = snapshot as unknown as UnknownRecord
  const direct = value.builtInProxyRuntimeState
  if (direct !== undefined) return direct
  return record(value.builtInProxy)?.runtime
}

function settingsFromSnapshot(snapshot: AppSnapshot): unknown {
  const value = snapshot as unknown as UnknownRecord
  const direct = value.builtInProxySettings
  if (direct !== undefined) return direct
  return record(value.builtInProxy)?.settings
}

/**
 * External proxy bindings stay editable while the built-in proxy is merely
 * desired but has no valid profile. Once takeover starts, they remain locked
 * through shutdown, and through errors after a successful activation.
 */
export function shouldInterlockExternalProxyBindings(runtime: unknown, fallbackSettings?: unknown): boolean {
  const state = record(runtime)
  const runtimeSettings = record(state?.settings)
  const settings = runtimeSettings ?? record(fallbackSettings)
  const status = typeof state?.status === 'string' ? state.status : undefined
  const desiredEnabled = typeof state?.desiredEnabled === 'boolean'
    ? state.desiredEnabled
    : settings?.desiredEnabled === true
  const hasEverActivated = settings?.hasEverActivated === true

  if (status === 'starting' || status === 'ready' || status === 'active' || status === 'stopping') return true
  if (status === 'error') return hasEverActivated
  if (status !== undefined) return false

  // During first render the runtime IPC may not have arrived yet. Persisted
  // activation history is enough to preserve fail-closed behavior, but a
  // first-time desired-only setup deliberately remains editable.
  return desiredEnabled && hasEverActivated
}

export function snapshotInterlocksExternalProxyBindings(snapshot: AppSnapshot): boolean {
  return shouldInterlockExternalProxyBindings(runtimeFromSnapshot(snapshot), settingsFromSnapshot(snapshot))
}

export function useBuiltInProxyInterlock(snapshot: AppSnapshot, api: GatewayApi): boolean {
  const snapshotRuntime = runtimeFromSnapshot(snapshot)
  const snapshotSettings = settingsFromSnapshot(snapshot)
  const [runtime, setRuntime] = useState<unknown>(snapshotRuntime)

  useEffect(() => {
    if (snapshotRuntime !== undefined) setRuntime(snapshotRuntime)
  }, [snapshotRuntime])

  useEffect(() => {
    let active = true
    let receivedRuntimeEvent = false
    const proxyApi = api as unknown as BuiltInProxyApiLike
    const apply = (next: unknown) => {
      if (active) setRuntime(next)
    }
    const unsubscribe = proxyApi.onBuiltInProxyState?.((next) => {
      receivedRuntimeEvent = true
      apply(next)
    })
    void proxyApi.getBuiltInProxyState?.().then((next) => {
      if (!receivedRuntimeEvent) apply(next)
    }).catch(() => undefined)
    return () => {
      active = false
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [api])

  return shouldInterlockExternalProxyBindings(runtime, snapshotSettings)
}
