import { describe, expect, it } from 'vitest'
import { deserializeChatGptCredential, parseChatGptAccountImport, serializeChatGptCredential } from '../../src/main/auth'

function token(exp: number, accountId = 'acct_claim', userId = 'user_claim') {
  return ['header', Buffer.from(JSON.stringify({
    exp,
    email: 'claim@example.com',
    sub: userId,
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      chatgpt_account_user_id: userId,
      chatgpt_user_id: userId,
      user_id: userId
    }
  })).toString('base64url'), 'signature'].join('.')
}

describe('ChatGPT account import', () => {
  it('parses the accents export shape without exposing tokens in metadata', () => {
    const expiresAt = Date.now() + 60 * 60 * 1000
    const parsed = parseChatGptAccountImport(JSON.stringify({
      access_token: token(Math.floor(expiresAt / 1000)),
      account_id: 'acct_team_1234',
      email: 'team@example.com',
      expired: new Date(expiresAt).toISOString(),
      refresh_token: ''
    }))
    expect(parsed.accounts[0]).toMatchObject({ accountId: 'acct_team_1234', email: 'team@example.com', expiresAt })
    expect(parsed.warnings).toHaveLength(1)
    expect(JSON.stringify(parsed.warnings)).not.toContain(parsed.accounts[0].accessToken)
  })

  it('keeps access-token-only members of the same workspace as separate accounts', () => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600
    const accountId = 'acct_shared_workspace'
    const firstToken = token(expiresAtSeconds, accountId, 'workspace_member_a')
    const secondToken = token(expiresAtSeconds, accountId, 'workspace_member_b')
    const parsed = parseChatGptAccountImport(JSON.stringify([
      { access_token: firstToken, account_id: accountId, email: 'first@example.com' },
      { access_token: secondToken, account_id: accountId, email: 'second@example.com' },
      { access_token: firstToken, account_id: accountId, email: 'first@example.com' }
    ]))

    expect(parsed.accounts).toHaveLength(2)
    expect(parsed.accounts.map((account) => account.userId)).toEqual([
      'workspace_member_a',
      'workspace_member_b'
    ])
    expect(new Set(parsed.accounts.map((account) => account.accountId))).toEqual(new Set([accountId]))
  })

  it('uses member identity instead of workspace identity for renewable sessions', () => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600
    const accountId = 'acct_shared_renewable_workspace'
    const parsed = parseChatGptAccountImport(JSON.stringify([
      {
        access_token: token(expiresAtSeconds, accountId, 'renewable_member_a'),
        refresh_token: 'refresh-a',
        account_id: accountId
      },
      {
        access_token: token(expiresAtSeconds, accountId, 'renewable_member_b'),
        refresh_token: 'refresh-b',
        account_id: accountId
      }
    ]))

    expect(parsed.accounts).toHaveLength(2)
  })

  it('keeps renewable sessions for the same member in different workspaces separate', () => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600
    const userId = 'member_with_multiple_workspaces'
    const parsed = parseChatGptAccountImport(JSON.stringify([
      {
        access_token: token(expiresAtSeconds, 'workspace_a', userId),
        refresh_token: 'refresh-workspace-a',
        account_id: 'workspace_a'
      },
      {
        access_token: token(expiresAtSeconds, 'workspace_b', userId),
        refresh_token: 'refresh-workspace-b',
        account_id: 'workspace_b'
      }
    ]))

    expect(parsed.accounts).toHaveLength(2)
  })

  it('does not merge distinct access-token-only cards that share user claims', () => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600
    const accountId = 'acct_shared_access_only_identity'
    const userId = 'shared_user_claim'
    const parsed = parseChatGptAccountImport(JSON.stringify([
      { access_token: token(expiresAtSeconds, accountId, userId), account_id: accountId },
      { access_token: token(expiresAtSeconds + 60, accountId, userId), account_id: accountId }
    ]))

    expect(parsed.accounts).toHaveLength(2)
    expect(parsed.accessTokenOnlyCount).toBe(2)
  })

  it('prefers a renewable session over an earlier access-token-only card for the same member', () => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600
    const accountId = 'acct_session_upgrade_workspace'
    const userId = 'upgraded_member'
    const parsed = parseChatGptAccountImport(JSON.stringify([
      {
        access_token: token(expiresAtSeconds, accountId, userId),
        account_id: accountId
      },
      {
        access_token: token(expiresAtSeconds + 60, accountId, userId),
        refresh_token: 'refresh-upgraded',
        account_id: accountId
      }
    ]))

    expect(parsed.accounts).toHaveLength(1)
    expect(parsed.accounts[0]).toMatchObject({
      accountId,
      userId,
      refreshToken: 'refresh-upgraded'
    })
    expect(parsed.warnings).toEqual([])
  })

  it('extracts account identity and expiry from JWT claims', () => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600
    const parsed = parseChatGptAccountImport(token(expiresAtSeconds, 'acct_jwt'))
    expect(parsed.accounts[0]).toMatchObject({ accountId: 'acct_jwt', expiresAt: expiresAtSeconds * 1000 })
    expect(JSON.stringify(parsed.warnings)).not.toContain('acct_jwt')
    expect(parsed.warnings[0]).toContain('no refresh token')
    expect(parsed.warnings[0]).not.toContain('claim@example.com')
  })

  it('rejects expired sessions and round-trips valid encrypted payloads', () => {
    expect(() => parseChatGptAccountImport(JSON.stringify({
      access_token: token(1), account_id: 'acct_expired', expired: '2000-01-01T00:00:00Z'
    }))).toThrow(/expired/)
    const bundle = {
      accessToken: 'secret-access', refreshToken: 'secret-refresh', accountId: 'acct',
      userId: 'user-private', expiresAt: Date.now() + 1000
    }
    expect(deserializeChatGptCredential(serializeChatGptCredential(bundle))).toEqual(bundle)

    const legacyExpiresAt = Date.now() + 60_000
    const legacy = deserializeChatGptCredential(JSON.stringify({
      accessToken: token(Math.floor(legacyExpiresAt / 1000), 'acct_legacy', 'legacy_user_private'),
      accountId: 'acct_legacy',
      expiresAt: legacyExpiresAt
    }))
    expect(legacy).toMatchObject({ userId: 'legacy_user_private' })
  })
})
