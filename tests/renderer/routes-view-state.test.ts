import { describe, expect, it } from 'vitest'
import type { AppSnapshot, Route } from '../../src/shared/types'
import {
  defaultModelAfterRouteSourceChange,
  routeEditorHasChanges,
  routeEnabledPayload,
  routePreviewIssuesForDisplay,
  routeSourceUsesGrok,
  routeSourceUsesNativeGrok,
  routeToggleAcknowledgementSignature,
  splitRouteModelMap,
  validateRouteMappings,
} from '../../src/renderer/src/views/RoutesView'

const route: Route = {
  id: 'route-codex',
  client: 'codex',
  enabled: true,
  poolId: 'pool-saved',
  inboundProtocol: 'openai-responses',
  modelMap: { alias: 'gpt-saved' },
  localToken: 'stone_saved',
  createdAt: 1,
  updatedAt: 2,
}

describe('route editor state boundaries', () => {
  it('builds an enabled toggle from the persisted route only', () => {
    const unsavedDraft = {
      ...route,
      poolId: 'pool-unsaved',
      localToken: 'stone_unsaved',
      modelMap: { alias: 'gpt-unsaved' },
    }

    const payload = routeEnabledPayload(route, false)
    expect(payload).toEqual({ ...route, enabled: false })
    expect(payload.poolId).not.toBe(unsavedDraft.poolId)
    expect(payload.modelMap).not.toEqual(unsavedDraft.modelMap)
  })

  it('rejects every visible unfinished or duplicate model mapping', () => {
    expect(validateRouteMappings([{ source: 'alias', target: '' }]))
      .toEqual({ valid: false, reason: 'incomplete' })
    expect(validateRouteMappings([{ source: '', target: '' }]))
      .toEqual({ valid: false, reason: 'incomplete' })
    expect(validateRouteMappings([
      { source: 'alias', target: 'first' },
      { source: ' alias ', target: 'second' },
    ])).toEqual({ valid: false, reason: 'duplicate-source' })
    expect(validateRouteMappings([{ source: ' alias ', target: ' gpt-5 ' }]))
      .toEqual({ valid: true, modelMap: { alias: 'gpt-5' } })
    expect(validateRouteMappings([{ source: '*', target: 'gpt-5' }]))
      .toEqual({ valid: false, reason: 'reserved-source' })
    expect(validateRouteMappings([{ source: 'alias', target: 'gpt-5' }], ' grok-4 '))
      .toEqual({ valid: true, modelMap: { alias: 'gpt-5', '*': 'grok-4' } })
  })

  it('keeps the reserved default mapping out of exact editor rows', () => {
    expect(splitRouteModelMap({ alias: 'gpt-5', '*': 'grok-4' })).toEqual({
      defaultUpstreamModel: 'grok-4',
      exactMappings: [{ source: 'alias', target: 'gpt-5' }],
    })
  })

  it('keeps unfinished rows in the unsaved-change calculation', () => {
    expect(routeEditorHasChanges(route, [{ source: 'alias', target: 'gpt-saved' }], route)).toBe(false)
    expect(routeEditorHasChanges(
      { ...route, updatedAt: 999 },
      [{ source: 'alias', target: 'gpt-saved' }],
      route,
    )).toBe(false)
    expect(routeEditorHasChanges(route, [
      { source: 'alias', target: 'gpt-saved' },
      { source: 'unfinished', target: '' },
    ], route)).toBe(true)
    expect(routeEditorHasChanges(route, [{ source: 'alias', target: 'gpt-saved' }], route, 'grok-4')).toBe(true)
  })

  it('recognizes a toggle acknowledgement despite a server timestamp update', () => {
    const expected = routeToggleAcknowledgementSignature(routeEnabledPayload(route, false))
    expect(routeToggleAcknowledgementSignature({ ...route, enabled: false, updatedAt: 99 })).toBe(expected)
    expect(routeToggleAcknowledgementSignature({ ...route, enabled: false, poolId: 'other', updatedAt: 99 }))
      .not.toBe(expected)
  })

  it('surfaces the Grok compatibility layer even when both route protocols are Responses', () => {
    const snapshot = {
      providers: [{ id: 'provider-grok', kind: 'xai', models: ['grok-4.5'] }],
      accounts: [{
        id: 'account-grok', providerId: 'provider-grok', credentialType: 'grok-oauth', status: 'active', updatedAt: 1,
        modelPolicy: 'selected', modelAllowlist: ['grok-4.5'], availableModels: ['grok-4.5'],
      }],
      pools: [{
        id: 'pool-grok', name: 'Grok', kind: 'standard', protocol: 'grok',
        members: [{ accountId: 'account-grok', enabled: true }],
      }],
    } as unknown as Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>

    expect(routeSourceUsesGrok('pool-grok', snapshot)).toBe(true)
    expect(defaultModelAfterRouteSourceChange('pool-grok', '', snapshot)).toBe('grok-4.5')
    expect(defaultModelAfterRouteSourceChange('pool-grok', 'gpt-5.6-sol', snapshot)).toBe('grok-4.5')
  })

  it('offers only Responses-native Grok sources to Grok Build', () => {
    const snapshot = {
      providers: [
        {
          id: 'provider-responses', name: 'Grok Responses', sourceType: 'relay', kind: 'xai-compatible',
          baseUrl: 'https://responses.example/v1', protocol: 'openai-responses', models: ['grok-4.5'],
          createdAt: 1, updatedAt: 1,
        },
        {
          id: 'provider-chat', name: 'Grok Chat', sourceType: 'relay', kind: 'xai-compatible',
          baseUrl: 'https://chat.example/v1', protocol: 'openai-chat', models: ['grok-4.5'],
          createdAt: 1, updatedAt: 1,
        },
      ],
      accounts: [
        {
          id: 'account-responses', providerId: 'provider-responses', credentialType: 'api-key', status: 'active',
          updatedAt: 1, modelPolicy: 'all', modelAllowlist: [], availableModels: ['grok-4.5'],
        },
        {
          id: 'account-chat', providerId: 'provider-chat', credentialType: 'api-key', status: 'active',
          updatedAt: 1, modelPolicy: 'all', modelAllowlist: [], availableModels: ['grok-4.5'],
        },
      ],
      pools: [
        {
          id: 'pool-responses', name: 'Grok Responses', kind: 'standard', protocol: 'grok',
          members: [{ accountId: 'account-responses', enabled: true }],
        },
        {
          id: 'pool-chat', name: 'Grok Chat', kind: 'standard', protocol: 'grok',
          members: [{ accountId: 'account-chat', enabled: true }],
        },
      ],
    } as unknown as Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>

    expect(routeSourceUsesNativeGrok('pool-responses', snapshot)).toBe(true)
    expect(routeSourceUsesNativeGrok('pool-chat', snapshot)).toBe(false)
  })

  it('hides a stale conversion notice for a native Grok Build route preview', () => {
    const issues = [
      { code: 'protocol-conversion', severity: 'info', message: 'legacy conversion message' },
      { code: 'model-mapped', severity: 'info', message: 'model mapping' },
    ] as const

    expect(routePreviewIssuesForDisplay({ client: 'grokbuild' }, issues, true)).toEqual([issues[1]])
    expect(routePreviewIssuesForDisplay({ client: 'codex' }, issues, true)).toEqual(issues)
  })
})
