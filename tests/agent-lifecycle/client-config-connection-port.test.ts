import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClientConfigConnectionPort } from '../../src/main/agent-lifecycle/client-config-connection-port'
import { ClientConfigService } from '../../src/main/client-config/service'

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
