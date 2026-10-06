import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { atomicWriteFile, readTextIfPresent } from '../../src/main/client-config/filesystem'
import {
  ClaudeDesktopConfig,
  type ClaudeDesktopFilesystemPort,
  type ClaudeDesktopInferenceModel,
  type ClaudeDesktopPolicyPort,
  inspectWindowsPolicy,
  resolveClaudeDesktopPaths,
  STONE_CLAUDE_DESKTOP_PROFILE_ID,
} from '../../src/main/agent-lifecycle/claude-desktop-config'

const roots: string[] = []
const connection = { gatewayBaseUrl: 'http://127.0.0.1:15720', token: 'secret-desktop-token' }
const unmanagedPolicy: ClaudeDesktopPolicyPort = { inspect: async () => ({ managed: false }) }
const routedModels: readonly ClaudeDesktopInferenceModel[] = [
  {
    name: 'stone-route-sonnet-v1',
    labelOverride: 'Stone+ Sonnet',
    anthropicFamilyTier: 'sonnet',
    isFamilyDefault: true,
  },
  { name: 'stone-route-opus-v1', anthropicFamilyTier: 'opus', isFamilyDefault: true },
]

async function createConfig(options: { filesystem?: ClaudeDesktopFilesystemPort; policy?: ClaudeDesktopPolicyPort } = {}) {
  const homeDir = await mkdtemp(join(tmpdir(), 'stone-claude-desktop-'))
  roots.push(homeDir)
  const environment = process.platform === 'win32'
    ? { LOCALAPPDATA: join(homeDir, 'Local') }
    : { XDG_CONFIG_HOME: join(homeDir, '.config') }
  const config = new ClaudeDesktopConfig({
    platform: process.platform,
    homeDir,
    environment,
    randomId: () => Math.random().toString(36).slice(2),
    policy: options.policy ?? unmanagedPolicy,
    filesystem: options.filesystem,
  })
  return { config, paths: config.paths() }
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ClaudeDesktopConfig', () => {
  it('resolves fixed Windows, macOS and Linux local profile paths', () => {
    const windows = resolveClaudeDesktopPaths({
      platform: 'win32',
      homeDir: 'C:\\Users\\stone',
      environment: { LOCALAPPDATA: 'C:\\Users\\stone\\AppData\\Local' },
    })
    expect(windows.normalConfigPath).toBe(win32.join(
      'C:\\Users\\stone\\AppData\\Local', 'Claude', 'claude_desktop_config.json',
    ))
    expect(windows.profilePath).toBe(win32.join(
      'C:\\Users\\stone\\AppData\\Local',
      'Claude-3p',
      'configLibrary',
      `${STONE_CLAUDE_DESKTOP_PROFILE_ID}.json`,
    ))

    const mac = resolveClaudeDesktopPaths({
      platform: 'darwin', homeDir: '/Users/stone', environment: {},
    })
    expect(mac.metaPath).toBe(posix.join(
      '/Users/stone', 'Library', 'Application Support', 'Claude-3p', 'configLibrary', '_meta.json',
    ))

    const linux = resolveClaudeDesktopPaths({
      platform: 'linux', homeDir: '/home/stone', environment: { XDG_CONFIG_HOME: '/var/config/stone' },
    })
    expect(linux.thirdPartyConfigPath).toBe(posix.join(
      '/var/config/stone', 'Claude-3p', 'claude_desktop_config.json',
    ))
  })

  it('applies the Stone+ 3P profile while preserving unrelated fields and profiles', async () => {
    const { config, paths } = await createConfig()
    const originals = new Map<string, string>([
      [paths.normalConfigPath, '{\n  "deploymentMode": "1p",\n  "normalKeep": true\n}\n'],
      [paths.thirdPartyConfigPath, '{\n  "deploymentMode": "1p",\n  "thirdPartyKeep": {"value": 1}\n}\n'],
      [paths.profilePath, '{\n  "customProfileField": {"keep": true},\n  "inferenceCustomHeaders": {"X-Keep": "yes", "X-Stone-Client": "old"},\n  "inferenceGatewayBaseUrl": "https://old.invalid",\n  "inferenceGatewayApiKey": "old-secret"\n}\n'],
      [paths.metaPath, JSON.stringify({
        appliedId: 'other-profile',
        customMetaField: true,
        entries: [
          { id: 'other-profile', name: 'Other', untouched: true },
          { id: STONE_CLAUDE_DESKTOP_PROFILE_ID, name: 'Old Stone name', retained: true },
        ],
      }, null, 2) + '\n'],
    ])
    await Promise.all([...originals].map(([path, content]) => writeText(path, content)))

    const repair = await config.repair(connection, routedModels)
    expect(repair.changed).toBe(true)
    expect(JSON.stringify(repair)).not.toContain(connection.token)

    const normal = await readJson(paths.normalConfigPath)
    const thirdParty = await readJson(paths.thirdPartyConfigPath)
    const profile = await readJson(paths.profilePath)
    const meta = await readJson(paths.metaPath)
    expect(normal).toMatchObject({ deploymentMode: '3p', normalKeep: true })
    expect(thirdParty).toMatchObject({ deploymentMode: '3p', thirdPartyKeep: { value: 1 } })
    expect(profile).toMatchObject({
      customProfileField: { keep: true },
      inferenceProvider: 'gateway',
      inferenceCredentialKind: 'static',
      inferenceGatewayBaseUrl: connection.gatewayBaseUrl,
      inferenceGatewayApiKey: connection.token,
      inferenceGatewayAuthScheme: 'bearer',
      inferenceCustomHeaders: { 'X-Keep': 'yes', 'X-Stone-Client': 'claude-code-desktop' },
      coworkEgressAllowedHosts: ['*'],
      disableDeploymentModeChooser: true,
      isClaudeCodeForDesktopEnabled: true,
      modelDiscoveryEnabled: false,
      inferenceModels: routedModels,
    })
    expect(meta).toMatchObject({
      appliedId: STONE_CLAUDE_DESKTOP_PROFILE_ID,
      customMetaField: true,
    })
    expect(meta.entries).toEqual([
      { id: 'other-profile', name: 'Other', untouched: true },
      { id: STONE_CLAUDE_DESKTOP_PROFILE_ID, name: 'Stone+', retained: true },
    ])
    await expect(config.inspect(connection, routedModels)).resolves.toBe(true)
    await expect(config.validate(connection, routedModels)).resolves.toBeUndefined()

    const firstContents = await Promise.all([...originals.keys()].map((path) => readFile(path, 'utf8')))
    const repeated = await config.repair(connection, routedModels)
    expect(repeated.changed).toBe(false)
    await expect(Promise.all([...originals.keys()].map((path) => readFile(path, 'utf8'))))
      .resolves.toEqual(firstContents)

    await repair.rollback()
    for (const [path, content] of originals) expect(await readFile(path, 'utf8')).toBe(content)
    await repair.rollback()
  })

  it('creates missing files and removes them again on rollback without returning credentials', async () => {
    const { config, paths } = await createConfig()
    const repair = await config.repair(connection)

    expect(repair.changed).toBe(true)
    expect(JSON.stringify(repair)).not.toContain(connection.token)
    await expect(config.inspect(connection)).resolves.toBe(true)
    expect(await readJson(paths.profilePath)).toMatchObject({
      coworkEgressAllowedHosts: ['*'],
      disableDeploymentModeChooser: true,
    })
    await repair.rollback()
    for (const path of [
      paths.normalConfigPath, paths.thirdPartyConfigPath, paths.profilePath, paths.metaPath,
    ]) {
      await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('normalizes existing custom capability values to the fixed CC Switch profile', async () => {
    const { config, paths } = await createConfig()
    await writeText(paths.profilePath, JSON.stringify({
      coworkEgressAllowedHosts: ['internal.example.com'],
      disableDeploymentModeChooser: false,
      unrelated: 'keep',
    }, null, 2) + '\n')

    await config.repair(connection, routedModels)
    const profile = await readJson(paths.profilePath)
    expect(profile.coworkEgressAllowedHosts).toEqual(['*'])
    expect(profile.disableDeploymentModeChooser).toBe(true)
    expect(profile.unrelated).toBe('keep')
    await expect(config.inspect(connection, routedModels)).resolves.toBe(true)
  })

  it('restores official mode transactionally and can restore the exact prior bytes', async () => {
    const { config, paths } = await createConfig()
    const originals = new Map<string, string>([
      [paths.normalConfigPath, '{\n  "deploymentMode": "3p",\n  "normalKeep": true\n}\n'],
      [paths.thirdPartyConfigPath, JSON.stringify({
        deploymentMode: '3p',
        thirdPartyKeep: true,
        enterpriseConfig: {
          disableDeploymentModeChooser: true,
          inferenceGatewayApiKey: connection.token,
          inferenceGatewayAuthScheme: 'bearer',
          inferenceGatewayBaseUrl: connection.gatewayBaseUrl,
          inferenceProvider: 'gateway',
          keepEnterpriseSetting: { enabled: true },
        },
      }, null, 2) + '\n'],
      [paths.profilePath, `{"inferenceGatewayApiKey":"${connection.token}","profile":true}\n`],
      [paths.metaPath, JSON.stringify({
        appliedId: STONE_CLAUDE_DESKTOP_PROFILE_ID,
        keepMeta: true,
        entries: [
          { id: STONE_CLAUDE_DESKTOP_PROFILE_ID, name: 'Stone+' },
          'invalid-entry-is-preserved',
          { id: 'other-profile', name: 'Other', keep: true },
        ],
      }, null, 2) + '\n'],
    ])
    await Promise.all([...originals].map(([path, content]) => writeText(path, content)))

    const restore = await config.restoreOfficial()
    expect(restore.changed).toBe(true)
    expect(JSON.stringify(restore)).not.toContain(connection.token)
    expect(await readJson(paths.normalConfigPath)).toEqual({ deploymentMode: '1p', normalKeep: true })
    expect(await readJson(paths.thirdPartyConfigPath)).toEqual({
      deploymentMode: '1p',
      thirdPartyKeep: true,
      enterpriseConfig: { keepEnterpriseSetting: { enabled: true } },
    })
    await expect(readFile(paths.profilePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readJson(paths.metaPath)).toEqual({
      appliedId: 'other-profile',
      keepMeta: true,
      entries: [
        'invalid-entry-is-preserved',
        { id: 'other-profile', name: 'Other', keep: true },
      ],
    })

    const officialContents = await Promise.all([
      readFile(paths.normalConfigPath, 'utf8'),
      readFile(paths.thirdPartyConfigPath, 'utf8'),
      readTextIfPresent(paths.profilePath),
      readFile(paths.metaPath, 'utf8'),
    ])
    const repeated = await config.restoreOfficial()
    expect(repeated.changed).toBe(false)
    await expect(Promise.all([
      readFile(paths.normalConfigPath, 'utf8'),
      readFile(paths.thirdPartyConfigPath, 'utf8'),
      readTextIfPresent(paths.profilePath),
      readFile(paths.metaPath, 'utf8'),
    ])).resolves.toEqual(officialContents)

    await restore.rollback()
    for (const [path, content] of originals) expect(await readFile(path, 'utf8')).toBe(content)
  })

  it('preserves a non-Stone applied profile and deletes an empty enterpriseConfig', async () => {
    const { config, paths } = await createConfig()
    await writeText(paths.thirdPartyConfigPath, JSON.stringify({
      deploymentMode: '3p',
      enterpriseConfig: {
        disableDeploymentModeChooser: true,
        inferenceGatewayApiKey: connection.token,
        inferenceGatewayAuthScheme: 'bearer',
        inferenceGatewayBaseUrl: connection.gatewayBaseUrl,
        inferenceProvider: 'gateway',
      },
    }, null, 2) + '\n')
    await writeText(paths.profilePath, `{"secret":"${connection.token}"}\n`)
    await writeText(paths.metaPath, JSON.stringify({
      appliedId: 'other-profile',
      entries: [{ id: STONE_CLAUDE_DESKTOP_PROFILE_ID, name: 'Stone+' }],
    }, null, 2) + '\n')

    await config.restoreOfficial()
    expect(await readJson(paths.thirdPartyConfigPath)).toEqual({ deploymentMode: '1p' })
    expect(await readJson(paths.metaPath)).toEqual({ appliedId: 'other-profile', entries: [] })
  })

  it('deletes appliedId when Stone was active and no valid profile remains', async () => {
    const { config, paths } = await createConfig()
    await writeText(paths.metaPath, JSON.stringify({
      appliedId: STONE_CLAUDE_DESKTOP_PROFILE_ID,
      entries: [
        { id: STONE_CLAUDE_DESKTOP_PROFILE_ID, name: 'Stone+' },
        { id: '', name: 'Invalid empty ID' },
        7,
      ],
      keep: true,
    }, null, 2) + '\n')

    await config.restoreOfficial()
    expect(await readJson(paths.metaPath)).toEqual({
      entries: [{ id: '', name: 'Invalid empty ID' }, 7],
      keep: true,
    })
  })

  it('refuses to roll back over a later user edit', async () => {
    const { config, paths } = await createConfig()
    const repair = await config.repair(connection, routedModels)
    const userEdit = `${await readFile(paths.normalConfigPath, 'utf8')}\n`
    await writeFile(paths.normalConfigPath, userEdit)

    await expect(repair.rollback()).rejects.toThrow('changed after repair')
    expect(await readFile(paths.normalConfigPath, 'utf8')).toBe(userEdit)
  })

  it('fails closed for takeover but restores official mode under organization policy', async () => {
    let inspectionCount = 0
    const managedPolicy: ClaudeDesktopPolicyPort = {
      inspect: async () => {
        inspectionCount += 1
        return { managed: true, reason: 'test-mdm' }
      },
    }
    const { config, paths } = await createConfig({ policy: managedPolicy })
    const originals = new Map<string, string>([
      [paths.normalConfigPath, '{"deploymentMode":"3p","keep":true}\n'],
      [paths.thirdPartyConfigPath, JSON.stringify({
        deploymentMode: '3p',
        keepThirdParty: true,
        enterpriseConfig: {
          inferenceGatewayApiKey: connection.token,
          inferenceGatewayBaseUrl: connection.gatewayBaseUrl,
          keepManagedPreference: true,
        },
      }) + '\n'],
      [paths.profilePath, `{"inferenceGatewayApiKey":"${connection.token}"}\n`],
      [paths.metaPath, JSON.stringify({
        appliedId: STONE_CLAUDE_DESKTOP_PROFILE_ID,
        entries: [
          { id: STONE_CLAUDE_DESKTOP_PROFILE_ID, name: 'Stone+' },
          { id: 'managed-profile', name: 'Managed profile' },
        ],
      }) + '\n'],
    ])
    await Promise.all([...originals].map(([path, content]) => writeText(path, content)))

    await expect(config.inspect(connection, routedModels)).resolves.toBe(false)
    const error = await config.repair(connection, routedModels).catch((caught) => caught as Error)
    expect(error.message).toContain('organization-managed')
    expect(error.message).not.toContain(connection.token)
    for (const [path, content] of originals) expect(await readFile(path, 'utf8')).toBe(content)
    expect(inspectionCount).toBe(2)

    const restore = await config.restoreOfficial()
    expect(restore.changed).toBe(true)
    expect(inspectionCount).toBe(2)
    expect(await readJson(paths.normalConfigPath)).toEqual({ deploymentMode: '1p', keep: true })
    expect(await readJson(paths.thirdPartyConfigPath)).toEqual({
      deploymentMode: '1p',
      keepThirdParty: true,
      enterpriseConfig: { keepManagedPreference: true },
    })
    await expect(readTextIfPresent(paths.profilePath)).resolves.toBeUndefined()
    expect(await readJson(paths.metaPath)).toEqual({
      appliedId: 'managed-profile',
      entries: [{ id: 'managed-profile', name: 'Managed profile' }],
    })

    const repeated = await config.restoreOfficial()
    expect(repeated.changed).toBe(false)
    expect(inspectionCount).toBe(2)

    await restore.rollback()
    for (const [path, content] of originals) expect(await readFile(path, 'utf8')).toBe(content)
    expect(inspectionCount).toBe(2)
  })

  it('restores official mode when organization policy inspection fails', async () => {
    let inspectionCount = 0
    const unreadablePolicy: ClaudeDesktopPolicyPort = {
      inspect: async () => {
        inspectionCount += 1
        throw new Error('simulated policy read failure')
      },
    }
    const { config, paths } = await createConfig({ policy: unreadablePolicy })
    await writeText(paths.normalConfigPath, '{"deploymentMode":"3p","keep":true}\n')
    await writeText(paths.profilePath, `{"inferenceGatewayApiKey":"${connection.token}"}\n`)

    await expect(config.inspect(connection, routedModels)).resolves.toBe(false)
    await expect(config.repair(connection, routedModels)).rejects.toThrow(
      'organization policy could not be verified',
    )
    expect(inspectionCount).toBe(2)

    await expect(config.restoreOfficial()).resolves.toMatchObject({ changed: true })
    expect(inspectionCount).toBe(2)
    expect(await readJson(paths.normalConfigPath)).toEqual({ deploymentMode: '1p', keep: true })
    await expect(readTextIfPresent(paths.profilePath)).resolves.toBeUndefined()
  })

  it('rejects missing or alias-only model lists before writing anything', async () => {
    const { config, paths } = await createConfig()
    await expect(config.repair(connection, [])).rejects.toThrow('at least one reachable full model ID')
    await expect(config.repair(connection, [{ name: 'sonnet' }])).rejects.toThrow('full model IDs')
    await expect(config.inspect(connection, [])).resolves.toBe(false)
    await expect(readTextIfPresent(paths.normalConfigPath)).resolves.toBeUndefined()
  })

  it('rolls back earlier files after a write failure and redacts the underlying error', async () => {
    let writeCount = 0
    const filesystem: ClaudeDesktopFilesystemPort = {
      read: readTextIfPresent,
      write: async (path, content, containsCredential) => {
        writeCount += 1
        if (writeCount === 4) throw new Error(`simulated failure: ${connection.token}`)
        await atomicWriteFile(path, content, () => Math.random().toString(36).slice(2), containsCredential)
      },
      remove: async (path) => rm(path, { force: true }),
    }
    const { config, paths } = await createConfig({ filesystem })
    const originals = new Map<string, string>([
      [paths.normalConfigPath, '{"deploymentMode":"1p","normal":true}\n'],
      [paths.thirdPartyConfigPath, '{"deploymentMode":"1p","thirdParty":true}\n'],
      [paths.profilePath, '{"profile":true,"coworkEgressAllowedHosts":["internal.example.com"],"disableDeploymentModeChooser":false}\n'],
      [paths.metaPath, '{"entries":[],"meta":true}\n'],
    ])
    await Promise.all([...originals].map(([path, content]) => writeText(path, content)))

    const error = await config.repair(connection, routedModels).catch((caught) => caught as Error)
    expect(error.message).toBe('Claude Code Desktop configuration could not be updated.')
    expect(String(error)).not.toContain(connection.token)
    for (const [path, content] of originals) expect(await readFile(path, 'utf8')).toBe(content)
  })

  it('restores every original byte when official-mode restoration fails after profile deletion', async () => {
    let operationCount = 0
    const filesystem: ClaudeDesktopFilesystemPort = {
      read: readTextIfPresent,
      write: async (path, content, containsCredential) => {
        operationCount += 1
        if (operationCount === 4) throw new Error(`restore failure: ${connection.token}`)
        await atomicWriteFile(path, content, () => Math.random().toString(36).slice(2), containsCredential)
      },
      remove: async (path) => {
        operationCount += 1
        await rm(path, { force: true })
      },
    }
    const { config, paths } = await createConfig({ filesystem })
    const originals = new Map<string, string>([
      [paths.normalConfigPath, '{"deploymentMode":"3p","normal":true}\n'],
      [paths.thirdPartyConfigPath, `{"deploymentMode":"3p","enterpriseConfig":{"inferenceGatewayApiKey":"${connection.token}"}}\n`],
      [paths.profilePath, `{"inferenceGatewayApiKey":"${connection.token}"}\n`],
      [paths.metaPath, JSON.stringify({
        appliedId: STONE_CLAUDE_DESKTOP_PROFILE_ID,
        entries: [{ id: STONE_CLAUDE_DESKTOP_PROFILE_ID, name: 'Stone+' }],
      }) + '\n'],
    ])
    await Promise.all([...originals].map(([path, content]) => writeText(path, content)))

    const error = await config.restoreOfficial().catch((caught) => caught as Error)
    expect(error.message).toBe('Claude Code Desktop configuration could not be updated.')
    expect(String(error)).not.toContain(connection.token)
    for (const [path, content] of originals) expect(await readFile(path, 'utf8')).toBe(content)
  })

  it('does not overwrite malformed foreign JSON or leak the token through parser errors', async () => {
    const { config, paths } = await createConfig()
    const malformed = `{"keep":"${connection.token}", broken}`
    await writeText(paths.normalConfigPath, malformed)

    const error = await config.repair(connection, routedModels).catch((caught) => caught as Error)
    expect(error.message).toBe('Claude Code Desktop configuration is not valid JSON.')
    expect(String(error)).not.toContain(connection.token)
    expect(await readFile(paths.normalConfigPath, 'utf8')).toBe(malformed)
    expect(await config.inspect(connection, routedModels)).toBe(false)
  })
})

describe('inspectWindowsPolicy', () => {
  const machineKey = 'HKLM\\SOFTWARE\\Policies\\Claude'
  const userKey = 'HKCU\\SOFTWARE\\Policies\\Claude'

  it('reads both hives and detects a user policy when the machine hive contains only update keys', async () => {
    const queried: string[] = []
    const inspection = await inspectWindowsPolicy(async (key) => {
      queried.push(key)
      return key === machineKey ? ['disableAutoUpdates'] : ['inferenceGatewayBaseUrl']
    })

    expect(queried).toEqual([machineKey, userKey])
    expect(inspection).toEqual({ managed: true })
  })

  it.each([
    { unreadableKey: machineKey, label: 'machine' },
    { unreadableKey: userKey, label: 'user' },
  ])('fails closed when the $label hive is unreadable while still reading both hives', async ({ unreadableKey }) => {
    const queried: string[] = []
    const inspection = await inspectWindowsPolicy(async (key) => {
      queried.push(key)
      return key === unreadableKey ? null : []
    })

    expect(queried).toEqual([machineKey, userKey])
    expect(inspection).toEqual({ managed: true, reason: 'policy-unreadable' })
  })

  it('treats empty and update-only hives as unmanaged', async () => {
    const inspection = await inspectWindowsPolicy(async (key) => (
      key === machineKey ? ['DisableAutoUpdates', 'AutoUpdaterEnforcementHours'] : []
    ))

    expect(inspection).toEqual({ managed: false })
  })
})
