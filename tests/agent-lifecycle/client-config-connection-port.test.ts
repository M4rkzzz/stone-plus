import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientConfigConnectionPort } from '../../src/main/agent-lifecycle/client-config-connection-port'
import { ClientConfigService } from '../../src/main/client-config/service'
import { repairAndValidateConnection } from '../../src/main/agent-lifecycle/integration'
import { CodexLifecycleAdapter } from '../../src/main/agent-lifecycle/codex-adapter'

const roots: string[] = []
const connection = { gatewayBaseUrl: 'http://127.0.0.1:15720', token: 'local-token' }

async function createPort() {
  const homeDir = await mkdtemp(join(tmpdir(), 'stone-agent-config-'))
  roots.push(homeDir)
  const service = new ClientConfigService({
    homeDir,
    platform: process.platform,
    now: () => new Date('2026-07-24T12:00:00.000Z'),
    randomId: () => Math.random().toString(36).slice(2),
  })
  return { service, port: new ClientConfigConnectionPort(service) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ClientConfigConnectionPort', () => {
  it.each([false, true])('only restores desktop runtime after configuration rollback succeeds (external edit=%s)', async (externalEdit) => {
    const { service, port } = await createPort()
    await service.apply('codex', connection)
    const original = await readFile(service.paths.codex.config.path, 'utf8')
    vi.spyOn(port, 'validate').mockImplementation(async () => {
      if (externalEdit) await writeFile(service.paths.codex.config.path, 'model = "gpt-user-new"\n')
      throw new Error('injected validation failure')
    })
    const desktop = { shutdownForRepair: vi.fn(async () => ({ wasRunning: true, launchTarget: 'fixture' })), relaunch: vi.fn(async () => undefined) }
    const adapter = new CodexLifecycleAdapter({ target: 'codex-desktop', desktop,
      desktopProbe: { inspect: async () => ({ installed: true, running: true, configured: false }) },
      deepRepair: { run: vi.fn() },
      prepareConnection: () => repairAndValidateConnection(port, 'codex', { ...connection, gatewayBaseUrl: 'http://127.0.0.1:15722' }),
    })
    await expect(adapter.start()).rejects.toThrow(externalEdit ? 'rollback also failed' : 'injected validation failure')
    expect(desktop.relaunch).toHaveBeenCalledTimes(externalEdit ? 0 : 1)
    expect(await readFile(service.paths.codex.config.path, 'utf8')).toBe(externalEdit ? 'model = "gpt-user-new"\n' : original)
  })

  it('preserves a newer external edit instead of blindly rolling it back', async () => {
    const { service, port } = await createPort()
    const repair = await port.repair('claude', connection)
    const newer = '{"env":{"ANTHROPIC_BASE_URL":"https://new.example"},"keep":"new"}\n'
    await writeFile(service.paths.claude.settings.path, newer)
    await expect(port.rollback('claude', repair)).rejects.toThrow('changed after connection repair')
    expect(await readFile(service.paths.claude.settings.path, 'utf8')).toBe(newer)
  })

  it('removes only untouched files created by first-run connection repair', async () => {
    const { service, port } = await createPort()
    const repair = await port.repair('gemini', connection)
    await port.rollback('gemini', repair)
    await expect(readFile(service.paths.gemini.env.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(service.paths.gemini.settings.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('repairs only Claude connection fields and validates the committed state', async () => {
    const { service, port } = await createPort()
    await mkdir(service.paths.claude.directory, { recursive: true })
    await writeFile(service.paths.claude.settings.path, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://old.example', KEEP_ENV: 'yes' },
      permissions: { allow: ['Read'] },
      mcpServers: { local: { command: 'local-tool' } },
    }, null, 2))

    const result = await port.repair('claude', connection)
    await port.validate('claude', connection)

    const restored = JSON.parse(await readFile(service.paths.claude.settings.path, 'utf8'))
    expect(restored).toMatchObject({
      env: {
        ANTHROPIC_BASE_URL: connection.gatewayBaseUrl,
        ANTHROPIC_AUTH_TOKEN: connection.token,
        KEEP_ENV: 'yes',
      },
      permissions: { allow: ['Read'] },
      mcpServers: { local: { command: 'local-tool' } },
    })
    expect(result.backups).toHaveLength(1)
  })

  it('repairs Gemini connection fields while preserving settings and dotenv entries', async () => {
    const { service, port } = await createPort()
    await mkdir(service.paths.gemini.directory, { recursive: true })
    await writeFile(service.paths.gemini.settings.path, '{"ui":{"theme":"keep"},"security":{"auth":{"custom":true}}}\n')
    await writeFile(service.paths.gemini.env.path, 'KEEP_ME=yes\nGEMINI_API_KEY=old\n')

    await port.repair('gemini', connection)
    await port.validate('gemini', connection)

    expect(JSON.parse(await readFile(service.paths.gemini.settings.path, 'utf8'))).toMatchObject({
      ui: { theme: 'keep' },
      security: { auth: { custom: true, selectedType: 'gemini-api-key' } },
    })
    const env = await readFile(service.paths.gemini.env.path, 'utf8')
    expect(env).toContain('KEEP_ME=yes')
    expect(env).toContain('GEMINI_API_KEY="local-token"')
    expect(env).toContain('GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:15720"')
  })

  it('rolls a completed repair back from its coherent backup set', async () => {
    const { service, port } = await createPort()
    await mkdir(service.paths.claude.directory, { recursive: true })
    const original = '{"env":{"ANTHROPIC_BASE_URL":"https://official.example"},"keep":true}\n'
    await writeFile(service.paths.claude.settings.path, original)

    const repair = await port.repair('claude', connection)
    await port.rollback('claude', repair)

    expect(await readFile(service.paths.claude.settings.path, 'utf8')).toBe(original)
  })
})
