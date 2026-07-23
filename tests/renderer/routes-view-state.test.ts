import { describe, expect, it } from 'vitest'
import type { Route } from '../../src/shared/types'
import {
  routeEditorHasChanges,
  routeEnabledPayload,
  routeToggleAcknowledgementSignature,
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
  })

  it('recognizes a toggle acknowledgement despite a server timestamp update', () => {
    const expected = routeToggleAcknowledgementSignature(routeEnabledPayload(route, false))
    expect(routeToggleAcknowledgementSignature({ ...route, enabled: false, updatedAt: 99 })).toBe(expected)
    expect(routeToggleAcknowledgementSignature({ ...route, enabled: false, poolId: 'other', updatedAt: 99 }))
      .not.toBe(expected)
  })
})
