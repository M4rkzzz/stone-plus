import { describe, expect, it, vi } from 'vitest'
import type { Account } from '../../src/shared/types'
import type { ClientConfigService } from '../../src/main/client-config'
import { CodexOfficialAuthBridge } from '../../src/main/codex-official-auth'
import type { AppStore } from '../../src/main/store/app-store'

describe('CodexOfficialAuthBridge', () => {
  it('lets the gateway use Codex-owned access without exposing refresh recovery', async () => {
    const now = Date.now()
    const auth = officialAuth(now + 60 * 60_000)
    const { bridge } = createBridge(auth, storedCredential(now + 30 * 60_000))

    await expect(bridge.gatewayCredential(runtimeAccount(), now)).resolves.toEqual({
      owned: true,
      accessToken: auth.accessToken,
      accountId: 'official-account',
    })
  })

  it('keeps Codex ownership when its access expires so Stone never races the refresh token', async () => {
    const now = Date.now()
    const auth = officialAuth(now + 10_000)
    const { bridge } = createBridge(auth, storedCredential(now + 30 * 60_000))

    await expect(bridge.gatewayCredential(runtimeAccount(), now)).resolves.toEqual({ owned: true })
  })

  it('does not claim an account different from the official auth.json identity', async () => {
    const now = Date.now()
    const auth = { ...officialAuth(now + 60 * 60_000), accountId: 'different-account' }
    const { bridge } = createBridge(auth, storedCredential(now + 30 * 60_000))

    await expect(bridge.gatewayCredential(runtimeAccount(), now)).resolves.toEqual({ owned: false })
  })
})

function createBridge(
  auth: ReturnType<typeof officialAuth>,
  serialized: string,
): { bridge: CodexOfficialAuthBridge } {
  const clientConfig = {
    readCodexOfficialAccountAuth: vi.fn(async () => auth),
  } as unknown as ClientConfigService
  const store = {
    getCredential: vi.fn(() => serialized),
    getRuntimeAccounts: vi.fn(() => [runtimeAccount()]),
    persistRotatedChatGptCredential: vi.fn(),
  } as unknown as AppStore
  return { bridge: new CodexOfficialAuthBridge(clientConfig, store) }
}

function runtimeAccount(): Account {
  return {
    id: 'stone-account',
    credentialId: 'stone-credential',
    credentialType: 'chatgpt-oauth',
    chatgptAccountId: 'official-account',
  } as Account
}

function storedCredential(expiresAt: number): string {
  return JSON.stringify({
    accessToken: token({
      sub: 'shared-user',
      exp: Math.floor(expiresAt / 1000),
      'https://api.openai.com/auth': { chatgpt_account_id: 'official-account' },
    }),
    refreshToken: 'stone-refresh',
    idToken: idToken('shared-user', expiresAt),
    accountId: 'official-account',
    userId: 'shared-user',
    expiresAt,
  })
}

function officialAuth(expiresAt: number) {
  return {
    accessToken: token({
      sub: 'shared-user',
      exp: Math.floor(expiresAt / 1000),
      'https://api.openai.com/auth': { chatgpt_account_id: 'official-account' },
    }),
    refreshToken: 'codex-refresh',
    idToken: idToken('shared-user', expiresAt),
    accountId: 'official-account',
    lastRefreshAt: expiresAt - 60 * 60_000,
  }
}

function idToken(subject: string, expiresAt: number): string {
  return token({
    iss: 'https://auth.openai.com',
    aud: ['app_EMoamEEZ73f0CkXaXp7hrann'],
    sub: subject,
    exp: Math.floor(expiresAt / 1000),
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'official-account',
      chatgpt_plan_type: 'plus',
    },
  })
}

function token(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}
