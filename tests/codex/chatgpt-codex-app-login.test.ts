import { describe, expect, it, vi } from 'vitest'
import { ChatGptCodexAppLoginService } from '../../src/main/chatgpt-codex-app-login'
import type { ClientConfigService } from '../../src/main/client-config'
import type { CodexRepairAndRestartOptions, CodexRepairAndRestartService } from '../../src/main/codex'
import type { OutboundTransportManager } from '../../src/main/proxy'
import type { AppStore } from '../../src/main/store/app-store'

describe('ChatGptCodexAppLoginService', () => {
  it('closes, writes the selected official OAuth account, syncs sessions, and then reopens the single app', async () => {
    const events: string[] = []
    const activateCodexOfficialAccount = vi.fn(async (_credential: unknown) => {
      events.push('config')
      return {
        client: 'codex' as const,
        changedFiles: ['C:\\Users\\Alice\\.codex\\auth.json'],
        backups: [{ groupId: 'backup-group-1' }],
        removedBackups: [],
      }
    })
    const restoreBackupSet = vi.fn()
    const repairAndRestart = {
      run: vi.fn(async (options: CodexRepairAndRestartOptions) => {
        events.push('close')
        await options.beforeRepair?.()
        events.push('sessions')
        await options.beforeRelaunch?.()
        events.push('restart')
        return {} as never
      }),
    } as unknown as CodexRepairAndRestartService
    const service = createService({ activateCodexOfficialAccount, restoreBackupSet }, repairAndRestart)

    await service.open('account-oauth')

    expect(events).toEqual(['close', 'config', 'sessions', 'restart'])
    expect(activateCodexOfficialAccount).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      idToken: expect.stringMatching(/^header\..+\.signature$/),
      accountId: 'official-account',
      lastRefreshAt: expect.any(Number),
    }), { backupRetention: 9 })
    expect(repairAndRestart.run).toHaveBeenCalledWith(expect.objectContaining({
      targetProvider: 'openai',
      sessionRepairScope: 'startup-index',
      beforeRepair: expect.any(Function),
      rollbackBeforeRepair: expect.any(Function),
    }))
  })

  it('uses the fast path for an already-official Codex config', async () => {
    const activateCodexOfficialAccount = vi.fn(async () => ({
      client: 'codex' as const,
      changedFiles: ['auth.json'],
      backups: [{ groupId: 'official-account-switch' }],
      removedBackups: [],
    }))
    const fetchMock = vi.fn(async () => codexModelsResponse())
    const run = vi.fn(async (options: CodexRepairAndRestartOptions) => {
      expect(options.skipSessionRepair).toBe(true)
      expect(options.sessionRepairScope).toBeUndefined()
      expect(options.modelRepair).toBeUndefined()
      await options.beforeRepair?.()
      await options.beforeRelaunch?.()
      return {} as never
    })
    const service = createService({
      activateCodexOfficialAccount,
      validateCodexOfficialAccountActivation: vi.fn(async () => ({ requiresSessionRepair: false })),
    }, { run } as unknown as CodexRepairAndRestartService, {}, fetchMock as typeof fetch)

    await service.open('account-oauth')

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(activateCodexOfficialAccount).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      targetProvider: 'openai',
      skipSessionRepair: true,
    }))
  })

  it('restores the exact pre-switch config group when the coordinator invokes rollback', async () => {
    const restoreBackupSet = vi.fn(async () => ({}))
    const repairAndRestart = {
      run: vi.fn(async (options: CodexRepairAndRestartOptions) => {
        await options.beforeRepair?.()
        await options.rollbackBeforeRepair?.()
        throw new Error('session synchronization failed')
      }),
    } as unknown as CodexRepairAndRestartService
    const service = createService({
      activateCodexOfficialAccount: vi.fn(async () => ({
        client: 'codex' as const,
        changedFiles: ['auth.json'],
        backups: [{ groupId: 'exact-before-switch' }],
        removedBackups: [],
      })),
      restoreBackupSet,
    }, repairAndRestart)

    await expect(service.open('account-oauth')).rejects.toThrow('session synchronization failed')
    expect(restoreBackupSet).toHaveBeenCalledWith('codex', 'exact-before-switch')
  })

  it('rejects access-token-only accounts before closing Codex', async () => {
    const run = vi.fn()
    const service = createService({}, { run } as unknown as CodexRepairAndRestartService, {
      refreshToken: undefined,
    })

    await expect(service.open('account-oauth')).rejects.toThrow('refresh_token')
    expect(run).not.toHaveBeenCalled()
  })

  it('refreshes an expired ID token before writing auth.json or closing Codex', async () => {
    const now = Date.now()
    const activateCodexOfficialAccount = vi.fn(async () => ({
      client: 'codex' as const,
      changedFiles: ['auth.json'],
      backups: [{ groupId: 'fresh-id-token' }],
      removedBackups: [],
    }))
    const run = vi.fn(async (options: CodexRepairAndRestartOptions) => {
      await options.beforeRepair?.()
      return {} as never
    })
    const refreshedIdToken = officialIdToken({
      accountId: 'official-account',
      issuedAt: now,
      expiresAt: now + 60 * 60_000,
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === 'https://auth.openai.com/oauth/token'
      ? new Response(JSON.stringify({
          access_token: 'refreshed-access',
          refresh_token: 'rotated-refresh',
          id_token: refreshedIdToken,
          expires_in: 3600,
        }), { status: 200 })
      : codexModelsResponse())
    const service = createService(
      { activateCodexOfficialAccount },
      { run } as unknown as CodexRepairAndRestartService,
      {
        idToken: officialIdToken({
          accountId: 'official-account',
          issuedAt: now - 2 * 60 * 60_000,
          expiresAt: now - 60_000,
        }),
      },
      fetchMock as typeof fetch,
    )

    await service.open('account-oauth')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://auth.openai.com/oauth/token')
    expect(String(fetchMock.mock.calls[1][0])).toContain('/backend-api/codex/models')
    expect(activateCodexOfficialAccount).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'refreshed-access',
      refreshToken: 'rotated-refresh',
      idToken: refreshedIdToken,
      lastRefreshAt: Math.floor(now / 1000) * 1000,
    }), { backupRetention: 9 })
  })

  it('reclaims a newer Codex-managed refresh generation before preflight', async () => {
    const now = Date.now()
    let codexClosed = false
    const codexAccess = officialAccessToken({
      accountId: 'official-account',
      subject: 'shared-user',
      expiresAt: now + 2 * 60 * 60_000,
    })
    const codexId = officialIdToken({
      accountId: 'official-account',
      subject: 'shared-user',
      issuedAt: now,
      expiresAt: now + 60 * 60_000,
    })
    const activateCodexOfficialAccount = vi.fn(async () => ({
      client: 'codex' as const,
      changedFiles: ['auth.json'],
      backups: [{ groupId: 'reclaimed-codex-generation' }],
      removedBackups: [],
    }))
    const run = vi.fn(async (options: CodexRepairAndRestartOptions) => {
      codexClosed = true
      await options.beforeRepair?.()
      await options.beforeRelaunch?.()
      return {} as never
    })
    const service = createService(
      {
        activateCodexOfficialAccount,
        readCodexOfficialAccountAuth: vi.fn(async () => ({
          accessToken: codexAccess,
          refreshToken: 'codex-rotated-refresh',
          idToken: codexId,
          accountId: 'official-account',
          lastRefreshAt: now,
        })),
      },
      { run } as unknown as CodexRepairAndRestartService,
      {
        accessToken: officialAccessToken({
          accountId: 'official-account',
          subject: 'shared-user',
          expiresAt: now + 30 * 60_000,
        }),
        idToken: officialIdToken({
          accountId: 'official-account',
          subject: 'shared-user',
          issuedAt: now - 30 * 60_000,
          expiresAt: now + 30 * 60_000,
        }),
        expiresAt: now + 30 * 60_000,
      },
      vi.fn(async () => {
        expect(codexClosed).toBe(true)
        return codexModelsResponse()
      }) as typeof fetch,
    )

    await service.open('account-oauth')

    expect(activateCodexOfficialAccount).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: codexAccess,
      refreshToken: 'codex-rotated-refresh',
      idToken: codexId,
    }), { backupRetention: 9 })
  })

  it('reclaims the final auth.json generation flushed by Codex shutdown', async () => {
    const now = Date.now()
    const flushedAccess = officialAccessToken({
      accountId: 'official-account',
      subject: 'shared-user',
      expiresAt: now + 2 * 60 * 60_000,
    })
    const flushedId = officialIdToken({
      accountId: 'official-account',
      subject: 'shared-user',
      issuedAt: now,
      expiresAt: now + 60 * 60_000,
    })
    let authReads = 0
    const activateCodexOfficialAccount = vi.fn(async () => ({
      client: 'codex' as const,
      changedFiles: ['auth.json'],
      backups: [{ groupId: 'shutdown-flush' }],
      removedBackups: [],
    }))
    const run = vi.fn(async (options: CodexRepairAndRestartOptions) => {
      await options.beforeRepair?.()
      await options.beforeRelaunch?.()
      return {} as never
    })
    const service = createService(
      {
        activateCodexOfficialAccount,
        readCodexOfficialAccountAuth: vi.fn(async () => ++authReads <= 2 ? undefined : {
          accessToken: flushedAccess,
          refreshToken: 'shutdown-rotated-refresh',
          idToken: flushedId,
          accountId: 'official-account',
          lastRefreshAt: now,
        }),
      },
      { run } as unknown as CodexRepairAndRestartService,
      {
        accessToken: officialAccessToken({
          accountId: 'official-account',
          subject: 'shared-user',
          expiresAt: now + 30 * 60_000,
        }),
        idToken: officialIdToken({
          accountId: 'official-account',
          subject: 'shared-user',
          issuedAt: now - 30 * 60_000,
          expiresAt: now + 30 * 60_000,
        }),
        expiresAt: now + 30 * 60_000,
      },
      vi.fn(async () => codexModelsResponse()) as typeof fetch,
    )

    await service.open('account-oauth')

    expect(authReads).toBe(3)
    expect(activateCodexOfficialAccount).toHaveBeenLastCalledWith(expect.objectContaining({
      accessToken: flushedAccess,
      refreshToken: 'shutdown-rotated-refresh',
      idToken: flushedId,
    }), { backupRetention: 9 })
  })

  it('rejects an expired ID token when refresh does not return a replacement', async () => {
    const now = Date.now()
    const activateCodexOfficialAccount = vi.fn(async () => ({
      client: 'codex' as const,
      changedFiles: ['auth.json'],
      backups: [{ groupId: 'expired-id-fallback' }],
      removedBackups: [],
    }))
    const run = vi.fn(async (options: CodexRepairAndRestartOptions) => {
      await options.beforeRepair?.()
      return {} as never
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'refreshed-access-without-id',
      expires_in: 3600,
    }), { status: 200 }))
    const service = createService(
      { activateCodexOfficialAccount },
      { run } as unknown as CodexRepairAndRestartService,
      {
        idToken: officialIdToken({
          accountId: 'official-account',
          issuedAt: now - 2 * 60 * 60_000,
          expiresAt: now - 60_000,
        }),
      },
      fetchMock as typeof fetch,
    )

    await expect(service.open('account-oauth')).rejects.toThrow('身份令牌已过期')

    expect(activateCodexOfficialAccount).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('leaves Codex untouched when an expired-ID refresh is temporarily unavailable', async () => {
    const now = Date.now()
    const activateCodexOfficialAccount = vi.fn(async () => ({
      client: 'codex' as const,
      changedFiles: ['auth.json'],
      backups: [{ groupId: 'network-fallback' }],
      removedBackups: [],
    }))
    const run = vi.fn(async (options: CodexRepairAndRestartOptions) => {
      await options.beforeRepair?.()
      return {} as never
    })
    const service = createService(
      { activateCodexOfficialAccount },
      { run } as unknown as CodexRepairAndRestartService,
      {
        idToken: officialIdToken({
          accountId: 'official-account',
          issuedAt: now - 2 * 60 * 60_000,
          expiresAt: now - 60_000,
        }),
      },
      vi.fn(async () => { throw new Error('temporary network failure') }) as typeof fetch,
    )

    await expect(service.open('account-oauth')).rejects.toThrow('Codex App 未被关闭或修改')

    expect(activateCodexOfficialAccount).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('refreshes and rechecks one upstream 401 before changing Codex App', async () => {
    const activateCodexOfficialAccount = vi.fn(async () => ({
      client: 'codex' as const,
      changedFiles: ['auth.json'],
      backups: [{ groupId: 'recovered-401' }],
      removedBackups: [],
    }))
    const run = vi.fn(async (options: CodexRepairAndRestartOptions) => {
      await options.beforeRepair?.()
      return {} as never
    })
    let modelProbes = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://auth.openai.com/oauth/token') {
        return new Response(JSON.stringify({
          access_token: 'recovered-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
        }), { status: 200 })
      }
      modelProbes += 1
      return modelProbes === 1 ? new Response(null, { status: 401 }) : codexModelsResponse()
    })
    const service = createService(
      { activateCodexOfficialAccount },
      { run } as unknown as CodexRepairAndRestartService,
      {},
      fetchMock as typeof fetch,
    )

    await service.open('account-oauth')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(activateCodexOfficialAccount).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'recovered-access',
      refreshToken: 'rotated-refresh',
    }), { backupRetention: 9 })
    expect(run).toHaveBeenCalledOnce()
  })

  it('rejects a wrong-account ID token even while the access token is usable', async () => {
    const now = Date.now()
    const run = vi.fn()
    const activateCodexOfficialAccount = vi.fn()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'refreshed-access-without-id',
      expires_in: 3600,
    }), { status: 200 }))
    const service = createService(
      { activateCodexOfficialAccount },
      { run } as unknown as CodexRepairAndRestartService,
      {
        idToken: officialIdToken({
          accountId: 'different-account',
          issuedAt: now,
          expiresAt: now + 60 * 60_000,
        }),
      },
      fetchMock as typeof fetch,
    )

    await expect(service.open('account-oauth')).rejects.toThrow('与所选账号不匹配')
    expect(activateCodexOfficialAccount).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('joins duplicate clicks for the same account and rejects a competing account', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = vi.fn(async () => {
      await gate
      return {} as never
    })
    const service = createService({}, { run } as unknown as CodexRepairAndRestartService)

    const first = service.open('account-oauth')
    const duplicate = service.open('account-oauth')
    const competing = service.open('different-account')

    expect(duplicate).toBe(first)
    await expect(competing).rejects.toThrow('另一个 Codex App 账号切换正在进行')
    release()
    await first
    expect(run).toHaveBeenCalledOnce()
  })

  it('rejects an intercepted HTTP 200 page instead of treating status alone as authenticated', async () => {
    const run = vi.fn()
    const fetchMock = vi.fn(async () => new Response('<html>proxy portal</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }))
    const service = createService(
      {},
      { run } as unknown as CodexRepairAndRestartService,
      {},
      fetchMock as typeof fetch,
    )

    await expect(service.open('account-oauth')).rejects.toThrow('无效的模型目录')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(run).not.toHaveBeenCalled()
  })

  it('retries a transient Codex model failure before closing the app', async () => {
    const run = vi.fn(async () => ({} as never))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(codexModelsResponse())
    const delay = vi.fn(async () => undefined)
    const service = createService(
      {},
      { run } as unknown as CodexRepairAndRestartService,
      {},
      fetchMock as typeof fetch,
      { delay },
    )

    await service.open('account-oauth')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(delay).toHaveBeenCalledWith(250)
    expect(run).toHaveBeenCalledOnce()
  })

  it('uses the selected account model cache when the official catalog is rate limited', async () => {
    const run = vi.fn(async (options: CodexRepairAndRestartOptions) => {
      expect(options.modelRepair).toMatchObject({
        fallbackModel: 'gpt-5.6',
        allowedModels: ['gpt-5.6', 'gpt-5.5-codex'],
      })
      await options.beforeRepair?.()
      return {} as never
    })
    const service = createService(
      {},
      { run } as unknown as CodexRepairAndRestartService,
      {},
      vi.fn(async () => new Response(null, { status: 429 })) as typeof fetch,
      { availableModels: ['gpt-5.6', 'gpt-5.5-codex'] },
    )

    await service.open('account-oauth')

    expect(run).toHaveBeenCalledOnce()
  })

  it('does not switch on a rate limit when no safe model catalog is available', async () => {
    const run = vi.fn()
    const service = createService(
      {},
      { run } as unknown as CodexRepairAndRestartService,
      {},
      vi.fn(async () => new Response(null, { status: 429 })) as typeof fetch,
    )

    await expect(service.open('account-oauth')).rejects.toThrow('本地没有该账号的可用模型缓存')
    expect(run).not.toHaveBeenCalled()
  })

  it('validates the current Codex files before asking the coordinator to close the app', async () => {
    const run = vi.fn()
    const service = createService({
      validateCodexOfficialAccountActivation: vi.fn(async () => {
        throw new Error('auth.json is not a JSON object')
      }),
    }, { run } as unknown as CodexRepairAndRestartService)

    await expect(service.open('account-oauth')).rejects.toThrow('Codex App 未被关闭或修改')
    expect(run).not.toHaveBeenCalled()
  })

  it('restores and reapplies when OAuth rotates while auth.json is being written', async () => {
    const now = Date.now()
    const rotated = credentialJson({
      accessToken: 'rotated-during-write',
      refreshToken: 'rotated-refresh-during-write',
      idToken: officialIdToken({ accountId: 'official-account', issuedAt: now, expiresAt: now + 60 * 60_000 }),
      expiresAt: now + 60 * 60_000,
    })
    let current = ''
    const activatedAccessTokens: string[] = []
    const activateCodexOfficialAccount = vi.fn(async (credential: { accessToken: string }) => {
      activatedAccessTokens.push(credential.accessToken)
      if (activatedAccessTokens.length === 1) current = rotated
      return {
        client: 'codex' as const,
        changedFiles: ['auth.json'],
        backups: [{ groupId: activatedAccessTokens.length === 1 ? 'stale-write' : 'stable-write' }],
        removedBackups: [],
      }
    })
    const restoreBackupSet = vi.fn(async () => ({}))
    const repairAndRestart = {
      run: vi.fn(async (options: CodexRepairAndRestartOptions) => {
        await options.beforeRepair?.()
        await options.beforeRelaunch?.()
        return {} as never
      }),
    } as unknown as CodexRepairAndRestartService
    const service = createService(
      { activateCodexOfficialAccount, restoreBackupSet },
      repairAndRestart,
      {},
      vi.fn(async () => codexModelsResponse()) as typeof fetch,
      { getCredential: (fallback) => current || (current = fallback) },
    )

    await service.open('account-oauth')

    expect(activatedAccessTokens).toEqual(['access-token', 'rotated-during-write'])
    expect(restoreBackupSet).toHaveBeenCalledWith('codex', 'stale-write')
  })

  it('synchronizes a final token rotation after session repair and before relaunch', async () => {
    const now = Date.now()
    const rotated = credentialJson({
      accessToken: 'rotated-before-relaunch',
      refreshToken: 'rotated-refresh-before-relaunch',
      idToken: officialIdToken({ accountId: 'official-account', issuedAt: now, expiresAt: now + 60 * 60_000 }),
      expiresAt: now + 60 * 60_000,
    })
    let reads = 0
    const activatedAccessTokens: string[] = []
    const activateCodexOfficialAccount = vi.fn(async (credential: { accessToken: string }) => {
      activatedAccessTokens.push(credential.accessToken)
      return {
        client: 'codex' as const,
        changedFiles: ['auth.json'],
        backups: [{ groupId: `switch-${activatedAccessTokens.length}` }],
        removedBackups: [],
      }
    })
    const repairAndRestart = {
      run: vi.fn(async (options: CodexRepairAndRestartOptions) => {
        await options.beforeRepair?.()
        await options.beforeRelaunch?.()
        return {} as never
      }),
    } as unknown as CodexRepairAndRestartService
    const service = createService(
      { activateCodexOfficialAccount },
      repairAndRestart,
      {},
      vi.fn(async () => codexModelsResponse()) as typeof fetch,
      { getCredential: (fallback) => (++reads >= 4 ? rotated : fallback) },
    )

    await service.open('account-oauth')

    expect(activatedAccessTokens).toEqual(['access-token', 'rotated-before-relaunch'])
  })

  it('accepts a credential generation that stabilizes on the final relaunch write', async () => {
    const now = Date.now()
    const rotations = [1, 2, 3].map((generation) => credentialJson({
      accessToken: `relaunch-access-${generation}`,
      refreshToken: `relaunch-refresh-${generation}`,
      idToken: officialIdToken({ accountId: 'official-account', issuedAt: now, expiresAt: now + 60 * 60_000 }),
      expiresAt: now + 60 * 60_000,
    }))
    let current = ''
    let relaunchWrite = 0
    const activatedAccessTokens: string[] = []
    const activateCodexOfficialAccount = vi.fn(async (credential: { accessToken: string }) => {
      activatedAccessTokens.push(credential.accessToken)
      if (credential.accessToken.startsWith('relaunch-access-') && relaunchWrite < rotations.length - 1) {
        relaunchWrite += 1
        current = rotations[relaunchWrite]
      }
      return {
        client: 'codex' as const,
        changedFiles: ['auth.json'],
        backups: [{ groupId: `switch-${activatedAccessTokens.length}` }],
        removedBackups: [],
      }
    })
    const repairAndRestart = {
      run: vi.fn(async (options: CodexRepairAndRestartOptions) => {
        await options.beforeRepair?.()
        current = rotations[0]
        await options.beforeRelaunch?.()
        return {} as never
      }),
    } as unknown as CodexRepairAndRestartService
    const service = createService(
      { activateCodexOfficialAccount },
      repairAndRestart,
      {},
      vi.fn(async () => codexModelsResponse()) as typeof fetch,
      { getCredential: (fallback) => current || (current = fallback) },
    )

    await expect(service.open('account-oauth')).resolves.toBeUndefined()
    expect(activatedAccessTokens).toEqual([
      'access-token',
      'relaunch-access-1',
      'relaunch-access-2',
      'relaunch-access-3',
    ])
  })

  it('rejects a mixed access-token and ID-token user before closing Codex', async () => {
    const now = Date.now()
    const run = vi.fn()
    const accessToken = officialAccessToken({
      accountId: 'official-account',
      subject: 'user-access',
      expiresAt: now + 60 * 60_000,
    })
    const idToken = officialIdToken({
      accountId: 'official-account',
      subject: 'user-id',
      issuedAt: now,
      expiresAt: now + 60 * 60_000,
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === 'https://auth.openai.com/oauth/token'
      ? new Response(JSON.stringify({
          access_token: accessToken,
          refresh_token: 'rotated-mixed-refresh',
          id_token: idToken,
          expires_in: 3600,
        }), { status: 200 })
      : codexModelsResponse())
    const service = createService(
      {},
      { run } as unknown as CodexRepairAndRestartService,
      {
        accessToken,
        idToken,
      },
      fetchMock as typeof fetch,
    )

    await expect(service.open('account-oauth')).rejects.toThrow('不属于同一用户')
    expect(run).not.toHaveBeenCalled()
  })
})

function createService(
  clientConfigOverrides: Partial<ClientConfigService> = {},
  repairAndRestart: CodexRepairAndRestartService = { run: vi.fn() } as unknown as CodexRepairAndRestartService,
  credentialOverrides: {
    accessToken?: string
    refreshToken?: string
    idToken?: string
    accountId?: string
    expiresAt?: number
  } = {},
  fetchImplementation: typeof fetch = vi.fn(async () => codexModelsResponse()) as typeof fetch,
  testOptions: {
    getCredential?: (fallback: string) => string | undefined
    persistRotatedCredential?: (rotated: string, expected: string | undefined) => Promise<void>
    delay?: (milliseconds: number) => Promise<void>
    availableModels?: string[]
  } = {},
): ChatGptCodexAppLoginService {
  const now = Date.now()
  const credential = JSON.stringify({
    accessToken: credentialOverrides.accessToken ?? 'access-token',
    refreshToken: credentialOverrides.refreshToken === undefined && 'refreshToken' in credentialOverrides
      ? undefined
      : credentialOverrides.refreshToken ?? 'refresh-token',
    idToken: credentialOverrides.idToken === undefined && 'idToken' in credentialOverrides
      ? undefined
      : credentialOverrides.idToken ?? officialIdToken({
        accountId: 'official-account',
        issuedAt: now,
        expiresAt: now + 60 * 60_000,
      }),
    accountId: credentialOverrides.accountId ?? 'official-account',
    expiresAt: credentialOverrides.expiresAt ?? now + 60 * 60 * 1000,
  })
  let currentCredential = credential
  const runtimeAccount = {
    id: 'account-oauth',
    credentialId: 'credential-oauth',
    credentialType: 'chatgpt-oauth' as const,
    chatgptAccountId: 'official-account',
    availableModels: testOptions.availableModels ?? [],
  }
  const store = {
    getRuntimeAccounts: vi.fn(() => [runtimeAccount]),
    getRuntimeAccount: vi.fn(() => runtimeAccount),
    getCredential: vi.fn(() => testOptions.getCredential?.(currentCredential) ?? currentCredential),
    getSnapshot: vi.fn(() => ({
      proxies: [],
      gateway: { backupRetention: 9 },
    })),
    getProxyPassword: vi.fn(),
    persistRotatedChatGptCredential: vi.fn(async (_accountId: string, rotated: string, expected?: string) => {
      if (testOptions.persistRotatedCredential) return testOptions.persistRotatedCredential(rotated, expected)
      if (expected !== undefined && expected !== currentCredential) throw new Error('Account credential changed while it was being rotated.')
      currentCredential = rotated
    }),
  } as unknown as AppStore
  const outboundTransport = {
    fetchFor: vi.fn(() => fetchImplementation),
  } as unknown as OutboundTransportManager
  const clientConfig = {
    activateCodexOfficialAccount: vi.fn(async () => ({
      client: 'codex' as const,
      changedFiles: [],
      backups: [],
      removedBackups: [],
    })),
    validateCodexOfficialAccountActivation: vi.fn(async () => ({ requiresSessionRepair: true })),
    readCodexOfficialAccountAuth: vi.fn(async () => undefined),
    restoreBackupSet: vi.fn(),
    ...clientConfigOverrides,
  } as unknown as ClientConfigService

  return new ChatGptCodexAppLoginService({
    store,
    outboundTransport,
    clientConfig,
    repairAndRestart,
    backupRetention: () => 9,
    delay: testOptions.delay ?? vi.fn(async () => undefined),
  })
}

function codexModelsResponse(models = ['gpt-5.6', 'gpt-5.5-codex']): Response {
  return new Response(JSON.stringify({
    models: models.map((slug) => ({ slug, visibility: 'list' })),
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function credentialJson(input: {
  accessToken: string
  refreshToken: string
  idToken: string
  expiresAt: number
  accountId?: string
}): string {
  return JSON.stringify({
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    idToken: input.idToken,
    accountId: input.accountId ?? 'official-account',
    expiresAt: input.expiresAt,
  })
}

function officialIdToken(input: { accountId: string; issuedAt: number; expiresAt: number; subject?: string }): string {
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://auth.openai.com',
    aud: ['app_EMoamEEZ73f0CkXaXp7hrann'],
    ...(input.subject ? { sub: input.subject } : {}),
    iat: Math.floor(input.issuedAt / 1000),
    exp: Math.floor(input.expiresAt / 1000),
    'https://api.openai.com/auth': {
      chatgpt_account_id: input.accountId,
      chatgpt_plan_type: 'plus',
    },
  })).toString('base64url')
  return `header.${payload}.signature`
}

function officialAccessToken(input: { accountId: string; subject: string; expiresAt: number }): string {
  const payload = Buffer.from(JSON.stringify({
    sub: input.subject,
    exp: Math.floor(input.expiresAt / 1000),
    'https://api.openai.com/auth': {
      chatgpt_account_id: input.accountId,
    },
  })).toString('base64url')
  return `header.${payload}.signature`
}
