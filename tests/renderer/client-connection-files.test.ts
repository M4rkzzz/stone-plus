import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientConfigService } from '../../src/main/client-config/service'
import { runClientConnectionWorkflow } from '../../src/renderer/src/client-connection-workflow'
import { DEEPSEEK_V4_FLASH_CONTEXT_WINDOW } from '../../src/shared/deepseek'
import type { AgentLifecycleSnapshot } from '../../src/shared/agent-lifecycle'
import type { GatewayApi, Route } from '../../src/shared/types'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture(running = false) {
  const homeDir = await mkdtemp(join(tmpdir(), 'stone-connection-files-'))
  roots.push(homeDir)
  const service = new ClientConfigService({ homeDir, platform: process.platform })
  const previous: Route = { id: 'route', client: 'codex', enabled: true, poolId: 'old',
    inboundProtocol: 'openai-responses', modelMap: {}, localToken: 'fixture', createdAt: 1, updatedAt: 1 }
  let route = previous
  const connection = (selected = route) => ({ gatewayBaseUrl: 'http://127.0.0.1:15721', token: selected.localToken,
    codexModelRepair: { modelMap: {}, fallbackModel: 'gpt-5.6-sol' },
    ...(selected.poolId === 'deepseek' ? { modelContextWindow: DEEPSEEK_V4_FLASH_CONTEXT_WINDOW } : {}) })
  await service.apply('codex', connection())
  const lifecycle = { agents: { 'codex-desktop': { running, managedInstanceCount: running ? 1 : 0,
    processControl: 'full', capabilities: { canRestart: true } } } } as AgentLifecycleSnapshot
  const api = {
    getSnapshot: vi.fn(async () => ({ routes: [route], gatewayStatus: { running: true } })),
    getAgentLifecycleSnapshot: vi.fn(async () => lifecycle),
    previewClientConfig: vi.fn(async (_client: string, _profile?: string, proposed?: Route, mode?: 'repair') => {
      const plan = mode === 'repair' ? await service.planRepair('codex', connection(proposed)) : await service.plan('codex', connection(proposed))
      const current = await service.plan('codex', connection())
      return { ...plan, profileId: 'default-codex', routeChangesConnection: plan.files.some(file =>
        current.files.find(old => old.role === file.role)?.content !== file.content) }
    }),
    updateRoute: vi.fn(async (next: Route, expected: Route) => {
      expect(route).toEqual(expected)
      route = { ...next, updatedAt: route.updatedAt + 1 }
      return { routes: [route] }
    }),
    repairClientConfig: vi.fn(async () => service.repair('codex', connection())),
    rollbackClientConfigRepair: vi.fn(async (_client, _profile, group, revisions) => {
      await service.restoreBackupSet('codex', group, revisions)
    }),
    restoreAgent: vi.fn(async () => {
      await service.repair('codex', connection())
      return { status: 'succeeded', results: [], snapshot: lifecycle }
    }),
  }
  const options = { api: api as unknown as GatewayApi, previous, desired: previous, profileId: 'default-codex',
    targets: ['codex-desktop'] as const, confirmActivation: vi.fn(() => true), onLifecycle: vi.fn() }
  return { api, options, service, currentRoute: () => route }
}

describe('connection workflow with real isolated configuration files', () => {
  it.each([false, true])('repairs model-only residue even when ordinary connection preview is clean (running=%s)', async (running) => {
    const { api, options, service } = await fixture(running)
    const path = service.paths.codex.config.path
    await writeFile(path, 'model = "claude-sonnet-4-5"\n' + await readFile(path, 'utf8'))
    const ordinary = await api.previewClientConfig('codex')
    expect(ordinary.files.every(file => !file.changed)).toBe(true)
    await expect(runClientConnectionWorkflow(options)).resolves.toMatchObject({ updated: true })
    expect(await readFile(path, 'utf8')).toContain('model = "gpt-5.6-sol"')
    expect(api.previewClientConfig).toHaveBeenCalledWith('codex', 'default-codex', options.desired, 'repair')
    expect(options.confirmActivation).toHaveBeenCalledTimes(running ? 1 : 0)
  })

  it('cancels repair-only changes before altering the route or files', async () => {
    const { api, options, service } = await fixture(true)
    const path = service.paths.codex.config.path
    const original = 'model = "claude-sonnet-4-5"\n' + await readFile(path, 'utf8')
    await writeFile(path, original)
    options.confirmActivation.mockReturnValue(false)
    await expect(runClientConnectionWorkflow(options)).resolves.toMatchObject({ cancelled: true })
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(api.restoreAgent).not.toHaveBeenCalled()
    expect(api.updateRoute).not.toHaveBeenCalled()
  })

  it.each(['read-error', 'remaining-drift'] as const)('restores config and route after final verification %s', async (failure) => {
    const { api, options, service, currentRoute } = await fixture()
    const original = await readFile(service.paths.codex.config.path, 'utf8')
    const preview = api.previewClientConfig.getMockImplementation()!
    api.previewClientConfig.mockImplementation(async (...args) => {
      if (!args[2]) {
        if (failure === 'read-error') throw new Error('verification read failed')
        const plan = await preview(...args)
        return { ...plan, files: plan.files.map(file => ({ ...file, changed: true })) }
      }
      return preview(...args)
    })
    await expect(runClientConnectionWorkflow({ ...options, sourceOnly: true, desired: { ...options.previous, poolId: 'deepseek' } })).rejects.toThrow(/verifi/i)
    expect(currentRoute().poolId).toBe('old')
    expect(await readFile(service.paths.codex.config.path, 'utf8')).toBe(original)
    await expect(readFile(service.paths.codex.modelCatalog.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(api.rollbackClientConfigRepair).toHaveBeenCalledOnce()
  })

  it('preserves an external config edit and reports incomplete rollback instead of overwriting it', async () => {
    const { api, options, service } = await fixture()
    const preview = api.previewClientConfig.getMockImplementation()!
    api.previewClientConfig.mockImplementation(async (...args) => {
      if (!args[2]) {
        await writeFile(service.paths.codex.config.path, 'model = "gpt-user-new"\n')
        throw new Error('verification read failed')
      }
      return preview(...args)
    })
    await expect(runClientConnectionWorkflow({ ...options, sourceOnly: true, desired: { ...options.previous, poolId: 'deepseek' } }))
      .rejects.toThrow(/configuration rollback:.*changed after connection repair/)
    expect(await readFile(service.paths.codex.config.path, 'utf8')).toBe('model = "gpt-user-new"\n')
  })
})
