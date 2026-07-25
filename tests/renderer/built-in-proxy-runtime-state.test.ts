import { describe, expect, it } from 'vitest'
import type { BuiltInProxyRuntimeState } from '../../src/shared/types'
import {
  buildBuiltInProxyCustomRuleSet,
  errorCategoryLabel,
  errorMessage,
  isCurrentBuiltInRuntimeRequest,
  parseBuiltInProxyNodePanelPreferences,
  resolveBuiltInProxyGroupFilter,
  resolveBuiltInProxyTakeoverPresentation,
  runtimeErrorMessage,
  shouldAcceptBuiltInRuntimeResponse,
  shouldSyncBuiltInProxyRuleDraft,
  splitBuiltInProxyRuleValues,
} from '../../src/renderer/src/views/BuiltInProxyView'

function runtimeState(
  input: Pick<BuiltInProxyRuntimeState, 'status' | 'effectiveRoute'> & {
    accessMode?: BuiltInProxyRuntimeState['settings']['accessMode']
    accessState?: BuiltInProxyRuntimeState['accessState']
  },
): BuiltInProxyRuntimeState {
  const accessMode = input.accessMode ?? 'system'
  const routePort = input.effectiveRoute.mixedPort
  return {
    desiredEnabled: true,
    routeGeneration: input.effectiveRoute.generation,
    profiles: [],
    settings: {
      desiredEnabled: true,
      accessMode,
      ruleMode: 'rule',
      mixedPort: 3198,
      lanEnabled: false,
      autoStart: true,
      hasEverActivated: true,
      updatedAt: 1,
    },
    accessState: input.accessState ?? {
      mode: accessMode,
      status: input.status === 'ready' ? 'ready' : input.status === 'starting' ? 'applying' : input.status === 'error' ? 'error' : 'idle',
      ...(routePort ? { endpoint: `http://127.0.0.1:${routePort}` } : {}),
      ...(input.status === 'ready' ? { verifiedAt: 1 } : {}),
    },
    ...input,
  }
}

describe('built-in proxy runtime request ordering', () => {
  it('accepts a response only while its request and event revisions are current', () => {
    const guard = { requestSequence: 4, eventRevision: 7 }
    expect(isCurrentBuiltInRuntimeRequest(guard, 4, 7)).toBe(true)
    expect(isCurrentBuiltInRuntimeRequest(guard, 5, 7)).toBe(false)
    expect(isCurrentBuiltInRuntimeRequest(guard, 4, 8)).toBe(false)
  })

  it('rejects an old read after a same-generation pushed event', () => {
    const readStartedBeforeEvent = { requestSequence: 10, eventRevision: 2 }
    // The route generation can remain unchanged; the local event revision is
    // what prevents the older getState result from restoring stale settings.
    expect(isCurrentBuiltInRuntimeRequest(readStartedBeforeEvent, 11, 3)).toBe(false)
  })

  it('still accepts a stale-started action response when it advances the route generation', () => {
    const actionStartedBeforeRead = { requestSequence: 10, eventRevision: 2 }
    expect(shouldAcceptBuiltInRuntimeResponse(actionStartedBeforeRead, 11, 2, 7, 8)).toBe(true)
  })

  it('does not let an equal-generation response overwrite a newer pushed event', () => {
    const requestStartedBeforeEvent = { requestSequence: 10, eventRevision: 2 }
    expect(shouldAcceptBuiltInRuntimeResponse(requestStartedBeforeEvent, 11, 3, 8, 8)).toBe(false)
  })
})

describe('built-in proxy takeover presentation truth', () => {
  it('shows system-proxy takeover only for a matching ready mixed generation', () => {
    expect(resolveBuiltInProxyTakeoverPresentation(runtimeState({
      status: 'ready',
      effectiveRoute: { generation: 7, kind: 'built-in-mixed', mixedPort: 3198 },
    }))).toEqual({
      phase: 'ready',
      effectiveBuiltInRouteActive: true,
      accessApplied: true,
      expectedRouteKind: 'built-in-mixed',
      mixedPort: 3198,
    })
  })

  it('does not call a mismatched ready route takeover', () => {
    expect(resolveBuiltInProxyTakeoverPresentation(runtimeState({
      status: 'ready',
      accessMode: 'system',
      effectiveRoute: { generation: 8, kind: 'built-in-tun', mixedPort: 3198 },
    }))).toMatchObject({ phase: 'inconsistent', accessApplied: false })

    expect(resolveBuiltInProxyTakeoverPresentation(runtimeState({
      status: 'ready',
      accessMode: 'tun',
      effectiveRoute: { generation: 8, kind: 'built-in-mixed', mixedPort: 3198 },
    }))).toMatchObject({ phase: 'inconsistent', accessApplied: false })
  })

  it('requires a matching verified access-resource proof', () => {
    expect(resolveBuiltInProxyTakeoverPresentation(runtimeState({
      status: 'ready',
      effectiveRoute: { generation: 8, kind: 'built-in-mixed', mixedPort: 3198 },
      accessState: { mode: 'system', status: 'applying', endpoint: 'http://127.0.0.1:3198' },
    }))).toMatchObject({ phase: 'inconsistent', accessApplied: false })
    expect(resolveBuiltInProxyTakeoverPresentation(runtimeState({
      status: 'ready',
      effectiveRoute: { generation: 8, kind: 'built-in-mixed', mixedPort: 3198 },
      accessState: { mode: 'system', status: 'ready', endpoint: 'http://127.0.0.1:4198', verifiedAt: 1 },
    }))).toMatchObject({ phase: 'inconsistent', accessApplied: false })
    expect(resolveBuiltInProxyTakeoverPresentation(runtimeState({
      status: 'ready',
      effectiveRoute: { generation: 8, kind: 'built-in-mixed', mixedPort: 3198 },
      accessState: { mode: 'tun', status: 'ready', endpoint: 'http://127.0.0.1:3198', verifiedAt: 1 },
    }))).toMatchObject({ phase: 'inconsistent', accessApplied: false })
    expect(resolveBuiltInProxyTakeoverPresentation(runtimeState({
      status: 'ready',
      effectiveRoute: { generation: 8, kind: 'built-in-mixed', mixedPort: 3198 },
      accessState: { mode: 'system', status: 'ready', endpoint: 'http://user@127.0.0.1:3198', verifiedAt: 1 },
    }))).toMatchObject({ phase: 'inconsistent', accessApplied: false })

    const missingProjection = runtimeState({
      status: 'ready',
      effectiveRoute: { generation: 8, kind: 'built-in-mixed', mixedPort: 3198 },
    }) as unknown as Omit<BuiltInProxyRuntimeState, 'accessState'> & {
      accessState?: BuiltInProxyRuntimeState['accessState']
    }
    delete missingProjection.accessState
    expect(resolveBuiltInProxyTakeoverPresentation(missingProjection as BuiltInProxyRuntimeState)).toMatchObject({
      phase: 'inconsistent',
      accessApplied: false,
    })
  })

  it('requires a concrete healthy mixed port before presenting TUN as running', () => {
    expect(resolveBuiltInProxyTakeoverPresentation(runtimeState({
      status: 'ready',
      accessMode: 'tun',
      effectiveRoute: { generation: 9, kind: 'built-in-tun' },
    }))).toMatchObject({ phase: 'inconsistent', accessApplied: false })
    expect(resolveBuiltInProxyTakeoverPresentation(runtimeState({
      status: 'ready',
      accessMode: 'tun',
      effectiveRoute: { generation: 10, kind: 'built-in-tun', mixedPort: 3200 },
    }))).toMatchObject({ phase: 'ready', accessApplied: true, mixedPort: 3200 })
  })

  it('distinguishes fail-closed from a first takeover failure that retained the external route', () => {
    expect(resolveBuiltInProxyTakeoverPresentation(runtimeState({
      status: 'error',
      effectiveRoute: { generation: 11, kind: 'blocked' },
    }))).toMatchObject({ phase: 'blocked', accessApplied: false })
    expect(resolveBuiltInProxyTakeoverPresentation(runtimeState({
      status: 'error',
      effectiveRoute: { generation: 0, kind: 'external', externalMode: 'system' },
    }))).toMatchObject({ phase: 'failed', accessApplied: false })
  })

  it('never presents transition states as an applied access mode', () => {
    expect(resolveBuiltInProxyTakeoverPresentation(runtimeState({
      status: 'starting',
      effectiveRoute: { generation: 12, kind: 'external', externalMode: 'direct' },
    }))).toMatchObject({ phase: 'starting', accessApplied: false })
    expect(resolveBuiltInProxyTakeoverPresentation(runtimeState({
      status: 'stopping',
      effectiveRoute: { generation: 13, kind: 'built-in-mixed', mixedPort: 3198 },
    }))).toMatchObject({ phase: 'restoring', accessApplied: false })
  })
})

describe('built-in proxy action errors', () => {
  it('labels the shared TUN lifecycle category without implying every failure was elevation denial', () => {
    expect(errorCategoryLabel('tun-elevation', (zh) => zh)).toBe('TUN 接入失败')
    expect(errorCategoryLabel('tun-elevation', (_zh, en) => en)).toBe('TUN access failed')
  })

  it('keeps the concrete backend failure for native and cross-realm errors', () => {
    expect(errorMessage(new Error('TUN elevation was denied by the user.'), 'fallback')).toBe(
      'TUN elevation was denied by the user.',
    )
    expect(errorMessage({ message: 'Windows did not apply ProxyEnable=1.' }, 'fallback')).toBe(
      'Windows did not apply ProxyEnable=1.',
    )
  })

  it('uses the action-specific fallback only when no backend detail exists', () => {
    expect(errorMessage(null, 'Failed to apply the system proxy.')).toBe('Failed to apply the system proxy.')
  })

  it('localizes a verified competing system-proxy owner without hiding other backend errors', () => {
    const conflict = {
      category: 'system-proxy' as const,
      message: 'Windows or another proxy application changed or rejected the settings before takeover could be confirmed.',
      retryable: true,
    }
    expect(runtimeErrorMessage(conflict, (zh) => zh)).toBe(
      'Windows 或其他代理软件改写/拒绝了系统代理；请关闭其他软件的系统代理接管后重试。',
    )
    expect(runtimeErrorMessage(conflict, (_zh, en) => en)).toBe(conflict.message)
    expect(runtimeErrorMessage({ ...conflict, message: 'Snapshot journal could not be written.' }, (zh) => zh)).toBe(
      'Snapshot journal could not be written.',
    )
    expect(errorMessage(conflict, 'fallback', (zh) => zh)).toContain('请关闭其他软件的系统代理接管后重试')
  })
})

describe('built-in proxy node panel preferences', () => {
  it('restores the collapsed state and a separate group selection for each profile', () => {
    expect(parseBuiltInProxyNodePanelPreferences(JSON.stringify({
      collapsed: true,
      groupFilters: { primary: 'automatic', backup: '__ungrouped__' },
    }))).toEqual({
      collapsed: true,
      groupFilters: { primary: 'automatic', backup: '__ungrouped__' },
    })
  })

  it('falls back safely when persisted data or a saved group is no longer valid', () => {
    expect(parseBuiltInProxyNodePanelPreferences('{invalid')).toEqual({ collapsed: false, groupFilters: {} })
    expect(resolveBuiltInProxyGroupFilter('removed', ['automatic'], false)).toBe('all')
    expect(resolveBuiltInProxyGroupFilter('__ungrouped__', ['automatic'], false)).toBe('all')
    expect(resolveBuiltInProxyGroupFilter('__ungrouped__', ['automatic'], true)).toBe('__ungrouped__')
  })

  it('keeps preferences for the full persisted profile and group id boundary', () => {
    const profileId = 'p'.repeat(512)
    const groupId = 'g'.repeat(512)
    expect(parseBuiltInProxyNodePanelPreferences(JSON.stringify({
      collapsed: false,
      groupFilters: { [profileId]: groupId },
    })).groupFilters[profileId]).toBe(groupId)

    expect(parseBuiltInProxyNodePanelPreferences(JSON.stringify({
      collapsed: false,
      groupFilters: { ['p'.repeat(513)]: 'automatic', valid: 'g'.repeat(513) },
    }))).toEqual({ collapsed: false, groupFilters: {} })
  })
})

describe('built-in proxy visual rule editor', () => {
  it('normalizes comma and newline separated values without duplicates', () => {
    expect(splitBuiltInProxyRuleValues('example.com, api.example.com\nexample.com,  ')).toEqual([
      'example.com',
      'api.example.com',
    ])
  })

  it('builds ordered custom rules and leaves geographic conditions valueless', () => {
    expect(buildBuiltInProxyCustomRuleSet([
      { id: 'private', condition: 'private-network', valueText: 'ignored', action: 'direct' },
      { id: 'domains', condition: 'domain-suffix', valueText: 'example.com, example.org', action: 'proxy' },
    ], 'direct')).toEqual({
      rules: [
        { id: 'private', condition: 'private-network', values: [], action: 'direct' },
        { id: 'domains', condition: 'domain-suffix', values: ['example.com', 'example.org'], action: 'proxy' },
      ],
      finalAction: 'direct',
    })
  })

  it('allows an empty rule list but rejects a condition with no match value', () => {
    expect(buildBuiltInProxyCustomRuleSet([], 'proxy')).toEqual({ rules: [], finalAction: 'proxy' })
    expect(buildBuiltInProxyCustomRuleSet([
      { id: 'empty', condition: 'domain', valueText: '  ', action: 'proxy' },
    ], 'proxy')).toBeNull()
  })

  it('preserves multiple application protocols as one ordered rule', () => {
    expect(buildBuiltInProxyCustomRuleSet([
      { id: 'apps', condition: 'protocol', valueText: 'http, tls\ndns', action: 'block' },
    ], 'direct')).toEqual({
      rules: [{ id: 'apps', condition: 'protocol', values: ['http', 'tls', 'dns'], action: 'block' }],
      finalAction: 'direct',
    })
  })

  it('normalizes the visual dash notation used by port ranges', () => {
    expect(buildBuiltInProxyCustomRuleSet([
      { id: 'ports', condition: 'port-range', valueText: '1000-2000, 3000:4000', action: 'direct' },
    ], 'proxy')?.rules[0].values).toEqual(['1000:2000', '3000:4000'])
  })

  it('does not overwrite an unsaved draft when a runtime event arrives', () => {
    expect(shouldSyncBuiltInProxyRuleDraft('server-v2', 'server-v1', true)).toBe(false)
    expect(shouldSyncBuiltInProxyRuleDraft('server-v2', 'server-v1', false)).toBe(true)
    expect(shouldSyncBuiltInProxyRuleDraft('server-v1', 'server-v1', false)).toBe(false)
  })
})
