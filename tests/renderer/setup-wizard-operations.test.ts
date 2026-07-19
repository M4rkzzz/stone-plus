import { describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, Pool, PublicAccount } from '../../src/shared/types'
import { confirmSetupWizardAction, persistSetupWizardSourceProxy } from '../../src/renderer/src/setup-wizard-operations'

const account: PublicAccount = {
  id: 'account-1',
  providerId: 'provider-1',
  name: 'OAuth account',
  maskedCredential: '***',
  credentialType: 'chatgpt-oauth',
  status: 'active',
  priority: 2,
  weight: 3,
  maxConcurrency: 4,
  inFlight: 0,
  availableModels: [],
  modelPolicy: 'selected',
  modelAllowlist: ['gpt-test'],
  proxyId: 'old-proxy',
  createdAt: 1,
  updatedAt: 1,
}

describe('setup wizard operations', () => {
  it('persists the selected proxy while preserving account scheduling fields', async () => {
    const snapshot = {} as AppSnapshot
    const saveAccount = vi.fn().mockResolvedValue(snapshot)
    const saveAggregateRelay = vi.fn().mockResolvedValue(snapshot)

    await expect(persistSetupWizardSourceProxy({ saveAccount, saveAggregateRelay }, account, 'new-proxy')).resolves.toBe(snapshot)
    expect(saveAccount).toHaveBeenCalledWith({
      id: 'account-1',
      providerId: 'provider-1',
      name: 'OAuth account',
      priority: 2,
      weight: 3,
      maxConcurrency: 4,
      modelPolicy: 'selected',
      modelAllowlist: ['gpt-test'],
      proxyId: 'new-proxy',
    })
  })

  it('does not rewrite an unchanged proxy and supports clearing a proxy', async () => {
    const saveAccount = vi.fn().mockResolvedValue({} as AppSnapshot)
    const saveAggregateRelay = vi.fn().mockResolvedValue({} as AppSnapshot)
    await expect(persistSetupWizardSourceProxy({ saveAccount, saveAggregateRelay }, account, 'old-proxy')).resolves.toBeNull()
    expect(saveAccount).not.toHaveBeenCalled()

    await persistSetupWizardSourceProxy({ saveAccount, saveAggregateRelay }, account, '')
    expect(saveAccount).toHaveBeenCalledWith(expect.objectContaining({ proxyId: '' }))
  })

  it('persists the selected proxy on an aggregate relay instead of its first member', async () => {
    const snapshot = {} as AppSnapshot
    const saveAccount = vi.fn().mockResolvedValue(snapshot)
    const saveAggregateRelay = vi.fn().mockResolvedValue(snapshot)
    const aggregate = {
      id: 'aggregate-1', name: 'Aggregate', kind: 'relay-aggregate', protocol: 'openai-responses',
      strategy: 'weighted-round-robin', members: [
        { accountId: 'account-1', enabled: true, order: 0, weight: 2 },
        { accountId: 'account-2', enabled: true, order: 1, weight: 1 },
      ], modelPolicy: 'all', modelAllowlist: [], stickySessions: true, stickyTtlMinutes: 30,
      maxRetries: 1, proxyId: 'old-proxy', createdAt: 1, updatedAt: 1,
    } satisfies Pool

    await expect(persistSetupWizardSourceProxy(
      { saveAccount, saveAggregateRelay }, account, 'new-proxy', aggregate,
    )).resolves.toBe(snapshot)
    expect(saveAccount).not.toHaveBeenCalled()
    expect(saveAggregateRelay).toHaveBeenCalledWith(expect.objectContaining({
      id: 'aggregate-1', proxyId: 'new-proxy', members: [
        { accountId: 'account-1', order: 0, weight: 2 },
        { accountId: 'account-2', order: 1, weight: 1 },
      ],
    }))
  })

  it('only returns the success sentinel after the terminal action resolves', async () => {
    await expect(confirmSetupWizardAction(async () => undefined)).resolves.toBe(true)
    await expect(confirmSetupWizardAction(async () => { throw new Error('failed') })).rejects.toThrow('failed')
  })
})
