import { describe, expect, it } from 'vitest'
import type { AppSnapshot } from '../../src/shared/types'
import type { HelpReadiness } from '../../src/renderer/src/help-readiness'
import { buildSmartGuidanceActions } from '../../src/renderer/src/smart-guidance'

const t = (chinese: string) => chinese

function readiness(ready: boolean): HelpReadiness {
  const item = {
    id: 'source' as const,
    label: '已添加可用来源',
    description: '先添加一个来源',
    complete: ready,
    page: 'providers' as const,
    actionLabel: '添加来源',
  }
  return {
    items: [item],
    completedCount: ready ? 1 : 0,
    totalCount: 1,
    percentage: ready ? 100 : 0,
    ready,
    nextAction: ready ? null : item,
  }
}

function snapshot(overrides: Record<string, unknown> = {}): AppSnapshot {
  return {
    requestLogs: [],
    accounts: [],
    ...overrides,
  } as unknown as AppSnapshot
}

describe('smart guidance', () => {
  it('starts with the deterministic readiness action', () => {
    const actions = buildSmartGuidanceActions(snapshot(), readiness(false), t)
    expect(actions[0]).toMatchObject({ id: 'readiness:source', page: 'providers', tone: 'primary' })
  })

  it('surfaces recent failures and unhealthy accounts without exceeding three actions', () => {
    const now = 100_000
    const actions = buildSmartGuidanceActions(snapshot({
      requestLogs: [{ status: 'error', timestamp: now - 1000 }],
      accounts: [
        { status: 'cooldown' },
        { status: 'disabled' },
        { status: 'active' },
      ],
    }), readiness(false), t, now)

    expect(actions.map((action) => action.id)).toEqual(['readiness:source', 'recent-failures', 'account-attention'])
    expect(actions).toHaveLength(3)
  })

  it('guides a fully ready new setup to its first client request', () => {
    const actions = buildSmartGuidanceActions(snapshot(), readiness(true), t)
    expect(actions).toEqual([expect.objectContaining({ id: 'first-request', page: 'clients', tone: 'neutral' })])
  })
})
