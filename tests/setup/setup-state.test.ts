import { describe, expect, it } from 'vitest'
import { SETUP_WIZARD_METADATA_KEY, SetupWizardRepository } from '../../src/main/setup/setup-state'

class MemoryMetadata {
  readonly values = new Map<string, string>()
  readAppMetadata(key: string): string | undefined { return this.values.get(key) }
  async writeAppMetadata(key: string, value: string): Promise<void> { this.values.set(key, value) }
  async removeAppMetadata(key: string): Promise<void> { this.values.delete(key) }
}

describe('setup wizard repository', () => {
  it('creates, resumes and completes one credential-free session', async () => {
    const metadata = new MemoryMetadata()
    const repository = new SetupWizardRepository(metadata, () => 100)
    const first = await repository.save({ step: 'scan' })
    const source = await repository.save({
      sessionId: first.sessionId,
      step: 'source-config',
      sourceType: 'relay',
      sourceMethod: 'relay',
      sourceId: 'source-1',
      tagId: 'tag-plus',
      poolId: 'import-pool',
      proxyId: 'proxy-oauth',
      model: 'gpt-test',
      lastError: 'Bearer secret sk-supersecret',
    })
    expect(source).toMatchObject({
      sourceType: 'relay',
      sourceMethod: 'relay',
      sourceId: 'source-1',
      tagId: 'tag-plus',
      poolId: 'import-pool',
      proxyId: 'proxy-oauth',
      model: 'gpt-test'
    })
    expect(metadata.values.get(SETUP_WIZARD_METADATA_KEY)).not.toContain('supersecret')
    const verified = await repository.markVerified(first.sessionId)
    expect(verified).toMatchObject({ step: 'client-config', verifiedAt: 100 })
    const completed = await repository.complete(first.sessionId)
    expect(completed).toMatchObject({ step: 'complete', completed: true, dismissed: false })
  })

  it('persists dismissal so first-run auto-open is not repeated', async () => {
    const metadata = new MemoryMetadata()
    const repository = new SetupWizardRepository(metadata, () => 200)
    const state = await repository.dismiss()
    expect(state.dismissed).toBe(true)
    expect(repository.get()?.dismissed).toBe(true)
  })

  it('rejects a stale session update', async () => {
    const metadata = new MemoryMetadata()
    const repository = new SetupWizardRepository(metadata)
    await repository.save({ sessionId: 'current', step: 'scan' })
    await expect(repository.save({ sessionId: 'stale', step: 'source' })).rejects.toThrow('会话已更新')
  })

  it('does not allow progress updates to bypass the verified completion boundary', async () => {
    const metadata = new MemoryMetadata()
    const repository = new SetupWizardRepository(metadata, () => 250)
    const state = await repository.save({ step: 'verify' })

    await expect(repository.save({
      sessionId: state.sessionId,
      step: 'complete'
    })).rejects.toThrow('端到端验证')
    await expect(repository.complete(state.sessionId)).rejects.toThrow('端到端真实请求')
    await repository.save({ sessionId: state.sessionId, step: 'client-config' })
    await expect(repository.complete(state.sessionId)).rejects.toThrow('端到端真实请求')
    expect(repository.get()?.completed).toBe(false)
  })

  it('keeps credential-free route rollback metadata across progress updates', async () => {
    const metadata = new MemoryMetadata()
    const repository = new SetupWizardRepository(metadata, () => 275)
    const state = await repository.save({ step: 'routing' })
    await repository.recordRoutingMutation(state.sessionId, {
      routeId: 'route-codex', routeCreated: false, expectedUpdatedAt: 274,
      createdPoolId: 'wizard-pool',
      previous: {
        poolId: 'original-pool', enabled: true, highConcurrencyMode: true,
        inboundProtocol: 'openai-responses',
        modelMap: { alias: 'upstream' },
      },
    })
    const resumed = await repository.save({ sessionId: state.sessionId, step: 'gateway' })
    expect(resumed.routingRollbacks).toEqual([expect.objectContaining({
      routeId: 'route-codex', routeCreated: false, expectedUpdatedAt: 274,
      createdPoolIds: ['wizard-pool'],
      previous: expect.objectContaining({
        poolId: 'original-pool', highConcurrencyMode: true, modelMap: { alias: 'upstream' }
      }),
    })])
    expect(metadata.values.get(SETUP_WIZARD_METADATA_KEY)).not.toContain('localToken')
  })

  it('resumes OAuth resource selections and explicitly clears deleted optional resources', async () => {
    const metadata = new MemoryMetadata()
    const repository = new SetupWizardRepository(metadata, () => 300)
    const source = await repository.save({
      step: 'network',
      sourceType: 'oauth-system',
      sourceMethod: 'oauth',
      sourceId: 'oauth-account',
      tagId: 'tag-plus',
      poolId: 'import-pool',
      proxyId: 'proxy-oauth'
    })

    const resumed = repository.get()
    expect(resumed).toMatchObject({
      sessionId: source.sessionId,
      sourceType: 'oauth-system',
      sourceMethod: 'oauth',
      sourceId: 'oauth-account',
      tagId: 'tag-plus',
      poolId: 'import-pool',
      proxyId: 'proxy-oauth'
    })

    const cleared = await repository.save({
      sessionId: source.sessionId,
      step: 'source-config',
      tagId: null,
      poolId: null,
      proxyId: null
    })
    expect(cleared).toMatchObject({ sourceId: 'oauth-account' })
    expect(cleared.tagId).toBeUndefined()
    expect(cleared.poolId).toBeUndefined()
    expect(cleared.proxyId).toBeUndefined()
  })

  it('persists only a whitelisted credential-free source method', async () => {
    const metadata = new MemoryMetadata()
    metadata.values.set(SETUP_WIZARD_METADATA_KEY, JSON.stringify({
      sessionId: 'unsafe-method',
      step: 'source-config',
      completed: false,
      dismissed: false,
      sourceType: 'oauth-system',
      sourceMethod: 'https://auth.openai.com/callback?code=secret',
      createdAt: 1,
      updatedAt: 1
    }))

    expect(repositoryState(metadata)?.sourceMethod).toBeUndefined()
    const repository = new SetupWizardRepository(metadata, () => 400)
    const state = await repository.save({
      sessionId: 'unsafe-method',
      step: 'source-config',
      sourceMethod: 'token-json'
    })
    expect(state.sourceMethod).toBe('token-json')
    expect(metadata.values.get(SETUP_WIZARD_METADATA_KEY)).not.toContain('auth.openai.com')
  })

  it('drops short-lived OAuth UI fields and redacts callback query secrets', async () => {
    const metadata = new MemoryMetadata()
    const repository = new SetupWizardRepository(metadata, () => 500)
    const state = await repository.save({
      step: 'source-config',
      sourceType: 'oauth-system',
      sourceMethod: 'oauth',
      tagId: 'tag-k12',
      poolId: 'pool-existing',
      proxyId: 'proxy-existing',
      lastError: '回调失败：http://localhost:1455/auth/callback?code=private-code&state=private-state&access_token=private-token '
        + '{"refreshToken":"private-refresh","id_token":"private-id"}',
      // Simulate additional renderer-only data from a compromised or stale UI.
      // The repository must continue to persist only its explicit state model.
      oauthSessionId: 'oauth-session-private',
      authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=private-state',
      callbackUrl: 'http://localhost:1455/auth/callback?code=private-code&state=private-state',
    } as Parameters<SetupWizardRepository['save']>[0] & Record<string, unknown>)

    expect(state).toMatchObject({
      sourceType: 'oauth-system',
      sourceMethod: 'oauth',
      tagId: 'tag-k12',
      poolId: 'pool-existing',
      proxyId: 'proxy-existing',
    })
    expect(state).not.toHaveProperty('oauthSessionId')
    expect(state).not.toHaveProperty('authorizationUrl')
    expect(state).not.toHaveProperty('callbackUrl')
    const persisted = metadata.values.get(SETUP_WIZARD_METADATA_KEY) ?? ''
    for (const secret of [
      'oauth-session-private', 'private-code', 'private-state', 'private-token',
      'private-refresh', 'private-id', 'authorizationUrl', 'callbackUrl'
    ]) {
      expect(persisted).not.toContain(secret)
    }
  })
})

function repositoryState(metadata: MemoryMetadata) {
  return new SetupWizardRepository(metadata).get()
}
