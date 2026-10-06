import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DeepSeekHarnessCompanionInstaller,
  SUPPORTED_DEEPSEEK_HARNESS_VERSION,
  STONE_DSH_CONTROLLED_PROMPT,
  patchDshTerminalBashSource,
  withDeepSeekHarnessCompanionPatch,
} from '../../src/main/deepseek-harness'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('DeepSeek Harness model-family companion', () => {
  it('patches only the supported DSH terminal readiness literals and is idempotent', () => {
    const upstream = [
      'const CONTROLLED_PROMPT = "dsh> ";',
      'const remaining = Math.max(0, 6 - this.promptTail.length);',
    ].join('\n')

    const patched = patchDshTerminalBashSource(upstream)
    expect(patched).toContain(`const CONTROLLED_PROMPT = ${JSON.stringify(STONE_DSH_CONTROLLED_PROMPT)};`)
    expect(patched).toContain('const remaining = Math.max(0, CONTROLLED_PROMPT.length + 1 - this.promptTail.length);')
    expect(patchDshTerminalBashSource(patched)).toBe(patched)
    expect(() => patchDshTerminalBashSource('const CONTROLLED_PROMPT = "other";')).toThrow('does not match')
  })

  it('installs an idempotent credential-free official-DSH overlay', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stone-dsh-companion-'))
    temporaryDirectories.push(home)
    const installer = new DeepSeekHarnessCompanionInstaller(home)
    const credentialFile = join(home, '.env')

    const first = await installer.ensureInstalled({
      gatewayBaseUrl: 'http://127.0.0.1:15720/',
      credentialFile,
    })
    const second = await installer.ensureInstalled({
      gatewayBaseUrl: 'http://127.0.0.1:15720',
      credentialFile,
    })
    const patch = await readFile(first.patchPath, 'utf8')
    const plugin = await readFile(installer.pluginPath, 'utf8')

    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(patch).toContain('- id: llm-deepseek')
    expect(patch).toContain("name: '@deepseek-ai/dsh-llm-deepseek'")
    expect(patch).toContain('disabled: true')
    expect(patch).toContain('- id: compaction-basic')
    expect(patch).toContain("name: '@deepseek-ai/dsh-compaction-basic'")
    expect(patch).toContain('thresholdRatio: 0.55')
    expect(patch).toContain('retainRatio: 0.10')
    expect(patch).toContain('- id: command-compact')
    expect(patch).toContain('- id: tool-result-pruner')
    expect(patch).toContain('stoneplus-model-family-bridge')
    expect(patch).toContain('http://127.0.0.1:15720')
    expect(patch).toContain(SUPPORTED_DEEPSEEK_HARNESS_VERSION)
    expect(patch).toContain('providerId: "deepseek-official"')
    expect(patch).toContain(pathToFileURL(installer.pluginPath).href)
    expect(patch).not.toContain('stone-secret')
    expect(plugin).toContain("export const inject = ['apiProxy']")
    const companion = await import(`${pathToFileURL(installer.pluginPath).href}?test=${Date.now()}`)
    expect(companion).toMatchObject({ name: 'stoneplus-model-family-bridge' })
    expect(companion.internals.filterModelsResponse({
      rpcId: 'rpc-1',
      result: {
        ok: true,
        value: {
          current: { provider: 'deepseek-official', model: 'gpt-5.6-sol' },
          routable: true,
          groups: [
            {
              id: 'deepseek-official',
              name: 'Stone+',
              models: [
                { id: 'gpt-5.6-sol', name: 'GPT' },
                { id: 'deepseek-v4-flash', name: 'DeepSeek' },
              ],
            },
            {
              id: 'foreign-provider',
              name: 'Foreign',
              models: [{ id: 'gpt-5.6-sol', name: 'Duplicate GPT' }],
            },
          ],
          failures: [{ id: 'foreign-provider', name: 'Foreign', message: 'unavailable' }],
        },
      },
    }, ['gpt-5.6-sol'], 'deepseek-official')).toMatchObject({
      result: {
        value: {
          routable: true,
          groups: [{ models: [{ id: 'gpt-5.6-sol' }] }],
          failures: [],
        },
      },
    })
  })

  it('keeps user overlays ahead of the final Stone overlay and replaces only its duplicate', () => {
    const patch = join(tmpdir(), 'stone-model-family.patch.yml')
    const args = withDeepSeekHarnessCompanionPatch([
      'web',
      '--patch',
      join(tmpdir(), 'user.patch.yml'),
      `--patch=${join(tmpdir(), 'second-user.patch.yml')}`,
      '--patch',
      patch,
      '--host',
      '127.0.0.1',
    ], patch)

    expect(args).toEqual([
      'web',
      '--patch',
      join(tmpdir(), 'user.patch.yml'),
      `--patch=${join(tmpdir(), 'second-user.patch.yml')}`,
      '--patch',
      patch,
      '--host',
      '127.0.0.1',
    ])
  })

  it('rejects non-loopback gateway injection', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stone-dsh-companion-'))
    temporaryDirectories.push(home)
    const installer = new DeepSeekHarnessCompanionInstaller(home)

    await expect(installer.ensureInstalled({
      gatewayBaseUrl: 'https://gateway.example.test',
      credentialFile: join(home, '.env'),
    })).rejects.toThrow('loopback')
  })

  it('filters session.models and rejects a cross-family session.selectModel', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stone-dsh-companion-'))
    temporaryDirectories.push(home)
    const installer = new DeepSeekHarnessCompanionInstaller(home)
    const credentialFile = join(home, '.env')
    await writeFile(credentialFile, 'DEEPSEEK_API_KEY=stone-test-token\n')
    await installer.ensureInstalled({ gatewayBaseUrl: 'http://127.0.0.1:15720', credentialFile })
    const companion = await import(`${pathToFileURL(installer.pluginPath).href}?apply=${Date.now()}`)

    const fakeDshRoot = join(home, 'fake-dsh')
    const fakeDshEntry = join(fakeDshRoot, 'lib', 'bin.js')
    await mkdir(join(fakeDshRoot, 'lib'), { recursive: true })
    await writeFile(fakeDshEntry, '')
    await writeFile(join(fakeDshRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      version: SUPPORTED_DEEPSEEK_HARNESS_VERSION,
    }))

    const originalModels = vi.fn(async (request) => ({
      rpcId: request.rpcId,
      result: {
        ok: true,
        value: {
          current: { provider: 'deepseek-official', model: 'gpt-5.6-sol' },
          routable: true,
          groups: [{
            id: 'deepseek-official',
            name: 'Stone+',
            models: [{ id: 'gpt-5.6-sol' }, { id: 'deepseek-v4-flash' }],
          }],
          failures: [],
        },
      },
    }))
    const originalSelectModel = vi.fn(async () => ({
      rpcId: 'select-1',
      result: { ok: true, value: { selected: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } },
    }))
    const sessions = { models: originalModels, selectModel: originalSelectModel }
    let dispose: (() => void) | undefined
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => init?.method === 'POST'
      ? Response.json({ error: { message: 'This session is permanently bound to GPT-5.6 models.' } }, { status: 409 })
      : Response.json({ family: 'gpt', allowedModels: ['gpt-5.6-sol'] }))
    vi.stubGlobal('fetch', fetchMock)
    const previousEntry = process.argv[1]
    process.argv[1] = fakeDshEntry
    try {
      await companion.apply({
        apiProxy: { sessions },
        logger: { warn: vi.fn() },
        effect: (setup: () => () => void) => { dispose = setup() },
      }, {
        gatewayBaseUrl: 'http://127.0.0.1:15720',
        credentialFile,
        providerId: 'deepseek-official',
        supportedDshVersion: SUPPORTED_DEEPSEEK_HARNESS_VERSION,
      })

      const directory = await sessions.models({ rpcId: 'models-1', payload: { sessionId: 'session-1' } })
      expect(directory.result.value.groups[0].models).toEqual([{ id: 'gpt-5.6-sol' }])
      const foreignSelection = await sessions.selectModel({
        rpcId: 'select-foreign',
        payload: { sessionId: 'session-1', provider: 'foreign-provider', model: 'gpt-5.6-sol' },
      })
      expect(foreignSelection).toMatchObject({
        result: { ok: false, error: { code: 'model-unavailable' } },
      })
      const selection = await sessions.selectModel({
        rpcId: 'select-1',
        payload: { sessionId: 'session-1', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      })
      expect(selection).toMatchObject({
        result: { ok: false, error: { code: 'model-unavailable' } },
      })
      expect(originalSelectModel).not.toHaveBeenCalled()
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      dispose?.()
      process.argv[1] = previousEntry
    }
    expect(sessions.models).toBe(originalModels)
    expect(sessions.selectModel).toBe(originalSelectModel)
  })
})
