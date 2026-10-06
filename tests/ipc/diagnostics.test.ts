import { describe, expect, it } from 'vitest'
import { serializeDiagnostics } from '../../src/main/ipc/diagnostics'
import type { AppSnapshot } from '../../src/shared/types'

describe('diagnostic report privacy', () => {
  it('exports operational state without account identities or stored messages', () => {
    const snapshot = {
      providers: [{ id: 'provider', name: 'Sensitive provider name' }],
      accounts: [{
        id: 'account-local-id',
        name: 'Sensitive account name',
        credentialId: 'credential-reference',
        maskedCredential: 'chatgpt-****port',
        credentialType: 'chatgpt-oauth',
        chatgptAccountId: 'acct-team-private',
        status: 'disabled',
        circuitState: 'open',
        consecutiveFailures: 2,
        lastError: 'Upstream echoed access-private and acct-team-private'
      }],
      pools: [{ id: 'pool' }],
      routes: [{ id: 'route', localToken: 'stone-local-private' }],
      gatewayStatus: { running: false, host: '127.0.0.1', port: 15721, activeRequests: 0, totalRequests: 1, successRequests: 0 },
      healthEvents: [{
        timestamp: 1_700_000_000_000,
        kind: 'account-disabled',
        severity: 'error',
        accountId: 'account-local-id',
        accountName: 'Sensitive account name',
        providerName: 'Sensitive provider name',
        message: 'Stored secret access-private'
      }],
      observability: { last24Hours: {}, last7Days: {}, hourly: [], tokenRates: { last30Minutes: [], last4Hours: [], last24Hours: [], last7Days: [] } }
    } as unknown as AppSnapshot

    const report = serializeDiagnostics(snapshot, {
      version: '0.4.0',
      platform: 'win32',
      arch: 'x64',
      now: () => 1_700_000_000_000
    })

    expect(JSON.parse(report)).toMatchObject({
      version: '0.4.0',
      accounts: [{ credentialType: 'chatgpt-oauth', status: 'disabled', circuitState: 'open', consecutiveFailures: 2 }],
      healthEvents: [{ timestamp: 1_700_000_000_000, kind: 'account-disabled', severity: 'error' }]
    })
    for (const secret of ['access-private', 'acct-team-private', 'stone-local-private', 'credential-reference', 'Sensitive account name', 'Sensitive provider name']) {
      expect(report).not.toContain(secret)
    }
  })
})
