import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { ClientConnectionTarget } from '../client-config'
import { atomicWriteFile, pathStat, readTextIfPresent } from '../client-config/filesystem'

export const STONE_CLAUDE_DESKTOP_PROFILE_ID = '00000000-0000-4000-8000-000000157220'
export const STONE_CLAUDE_DESKTOP_PROFILE_NAME = 'Stone+'

export type ClaudeDesktopAnthropicFamilyTier = 'haiku' | 'sonnet' | 'opus' | 'fable' | 'mythos'

export interface ClaudeDesktopInferenceModel {
  name: string
  labelOverride?: string
  anthropicFamilyTier?: ClaudeDesktopAnthropicFamilyTier
  isFamilyDefault?: boolean
}

export const DEFAULT_CLAUDE_DESKTOP_INFERENCE_MODELS: readonly ClaudeDesktopInferenceModel[] = [
  { name: 'claude-sonnet-5', anthropicFamilyTier: 'sonnet', isFamilyDefault: true },
  { name: 'claude-opus-4-8', anthropicFamilyTier: 'opus', isFamilyDefault: true },
  { name: 'claude-fable-5', anthropicFamilyTier: 'fable', isFamilyDefault: true },
  { name: 'claude-haiku-4-5', anthropicFamilyTier: 'haiku', isFamilyDefault: true },
]

export interface ClaudeDesktopPaths {
  normalConfigPath: string
  thirdPartyConfigPath: string
  configLibraryPath: string
  profilePath: string
  metaPath: string
}

export interface ClaudeDesktopPolicyInspection {
  managed: boolean
  reason?: string
}

export interface ClaudeDesktopPolicyPort {
  inspect(paths: ClaudeDesktopPaths): Promise<ClaudeDesktopPolicyInspection>
}

export interface ClaudeDesktopFilesystemPort {
  read(path: string): Promise<string | undefined>
  write(path: string, content: string, containsCredential: boolean): Promise<void>
  remove(path: string): Promise<void>
}

export interface ClaudeDesktopConfigOptions {
  platform?: NodeJS.Platform
  homeDir?: string
  environment?: NodeJS.ProcessEnv
  randomId?: () => string
  policy?: ClaudeDesktopPolicyPort
  filesystem?: ClaudeDesktopFilesystemPort
}

export interface ClaudeDesktopConfigurationRepair {
  readonly changed: boolean
  rollback(): Promise<void>
}

interface FileSnapshot {
  path: string
  before: string | undefined
}

interface FilePlan extends FileSnapshot {
  after: string | undefined
}

const updateOnlyPolicyKeys = new Set(['disableautoupdates', 'autoupdaterenforcementhours'])
const validFamilyTiers = new Set<ClaudeDesktopAnthropicFamilyTier>([
  'haiku', 'sonnet', 'opus', 'fable', 'mythos',
])
const bareTierAliases = new Set(['haiku', 'sonnet', 'opus', 'fable', 'mythos'])

/** Resolve Claude Desktop's normal and third-party local configuration files. */
export function resolveClaudeDesktopPaths(options: ClaudeDesktopConfigOptions = {}): ClaudeDesktopPaths {
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? homedir()
  const environment = options.environment ?? process.env
  let normalDirectory: string
  let thirdPartyDirectory: string

  if (platform === 'win32') {
    const localAppData = absoluteEnvironmentPath(environment.LOCALAPPDATA, 'win32')
      ?? win32.join(homeDir, 'AppData', 'Local')
    normalDirectory = win32.join(localAppData, 'Claude')
    thirdPartyDirectory = win32.join(localAppData, 'Claude-3p')
  } else if (platform === 'darwin') {
    const applicationSupport = posix.join(homeDir, 'Library', 'Application Support')
    normalDirectory = posix.join(applicationSupport, 'Claude')
    thirdPartyDirectory = posix.join(applicationSupport, 'Claude-3p')
  } else if (platform === 'linux') {
    const configHome = absoluteEnvironmentPath(environment.XDG_CONFIG_HOME, platform)
      ?? posix.join(homeDir, '.config')
    normalDirectory = posix.join(configHome, 'Claude')
    thirdPartyDirectory = posix.join(configHome, 'Claude-3p')
  } else {
    throw new Error('Claude Code Desktop third-party configuration is not supported on this platform.')
  }

  const pathApi = platform === 'win32' ? win32 : posix
  const configLibraryPath = pathApi.join(thirdPartyDirectory, 'configLibrary')
  return {
    normalConfigPath: pathApi.join(normalDirectory, 'claude_desktop_config.json'),
    thirdPartyConfigPath: pathApi.join(thirdPartyDirectory, 'claude_desktop_config.json'),
    configLibraryPath,
    profilePath: pathApi.join(configLibraryPath, `${STONE_CLAUDE_DESKTOP_PROFILE_ID}.json`),
    metaPath: pathApi.join(configLibraryPath, '_meta.json'),
  }
}

/**
 * Owns Stone+'s single Claude Code Desktop 3P profile. The four related files
 * are updated serially from one snapshot and can be rolled back only while
 * their contents still match the result written by this operation.
 */
export class ClaudeDesktopConfig {
  private readonly pathsValue: ClaudeDesktopPaths
  private readonly policy: ClaudeDesktopPolicyPort
  private readonly filesystem: ClaudeDesktopFilesystemPort
  private pendingOperation: Promise<unknown> = Promise.resolve()

  constructor(options: ClaudeDesktopConfigOptions = {}) {
    const platform = options.platform ?? process.platform
    const homeDir = options.homeDir ?? homedir()
    const environment = options.environment ?? process.env
    const randomId = options.randomId ?? randomUUID
    this.pathsValue = resolveClaudeDesktopPaths({ platform, homeDir, environment })
    this.policy = options.policy ?? new DefaultClaudeDesktopPolicy({ platform, homeDir, environment })
    this.filesystem = options.filesystem ?? {
      read: readTextIfPresent,
      write: async (path, content, containsCredential) => {
        await atomicWriteFile(path, content, randomId, containsCredential)
      },
      remove: async (path) => {
        await rm(path, { force: true })
      },
    }
  }

  paths(): ClaudeDesktopPaths {
    return { ...this.pathsValue }
  }

  async inspect(
    target: ClientConnectionTarget,
    models: readonly ClaudeDesktopInferenceModel[] = DEFAULT_CLAUDE_DESKTOP_INFERENCE_MODELS,
  ): Promise<boolean> {
    let normalizedTarget: ClientConnectionTarget
    let normalizedModels: ClaudeDesktopInferenceModel[]
    try {
      normalizedTarget = validateConnectionTarget(target)
      normalizedModels = normalizeModels(models)
    } catch {
      return false
    }

    return this.runExclusive(async () => {
      try {
        if (await this.isOrganizationManaged()) return false
        const snapshots = await this.readSnapshots()
        return configurationMatches(snapshots, normalizedTarget, normalizedModels)
      } catch {
        return false
      }
    })
  }

  async repair(
    target: ClientConnectionTarget,
    models: readonly ClaudeDesktopInferenceModel[] = DEFAULT_CLAUDE_DESKTOP_INFERENCE_MODELS,
  ): Promise<ClaudeDesktopConfigurationRepair> {
    const normalizedTarget = validateConnectionTarget(target)
    const normalizedModels = normalizeModels(models)
    return this.runExclusive(async () => {
      await this.assertLocallyConfigurable()

      let snapshots: FileSnapshot[]
      let plans: FilePlan[]
      try {
        snapshots = await this.readSnapshots()
        plans = buildPlans(snapshots, normalizedTarget, normalizedModels)
      } catch (cause) {
        throw safeConfigurationError('Claude Code Desktop configuration is not valid JSON.', cause)
      }
      return this.commitPlans(plans)
    })
  }

  async restoreOfficial(): Promise<ClaudeDesktopConfigurationRepair> {
    return this.runExclusive(async () => {
      let snapshots: FileSnapshot[]
      let plans: FilePlan[]
      try {
        snapshots = await this.readSnapshots()
        plans = buildOfficialRestorePlans(snapshots)
      } catch (cause) {
        throw safeConfigurationError('Claude Code Desktop configuration is not valid JSON.', cause)
      }
      return this.commitPlans(plans)
    })
  }

  async validate(
    target: ClientConnectionTarget,
    models: readonly ClaudeDesktopInferenceModel[] = DEFAULT_CLAUDE_DESKTOP_INFERENCE_MODELS,
  ): Promise<void> {
    if (!await this.inspect(target, models)) {
      throw new Error('Claude Code Desktop is not configured for Stone+ or is organization-managed.')
    }
  }

  private async assertLocallyConfigurable(): Promise<void> {
    let managed: boolean
    try {
      managed = await this.isOrganizationManaged()
    } catch (cause) {
      throw safeConfigurationError('Claude Code Desktop organization policy could not be verified.', cause)
    }
    if (managed) {
      throw new Error('Claude Code Desktop is organization-managed; Stone+ did not change its configuration.')
    }
  }

  private async isOrganizationManaged(): Promise<boolean> {
    const result = await this.policy.inspect(this.pathsValue)
    return result.managed
  }

  private async readSnapshots(): Promise<FileSnapshot[]> {
    const paths = [
      this.pathsValue.normalConfigPath,
      this.pathsValue.thirdPartyConfigPath,
      this.pathsValue.profilePath,
      this.pathsValue.metaPath,
    ]
    return Promise.all(paths.map(async (path) => ({ path, before: await this.filesystem.read(path) })))
  }

  private async commitPlans(plans: readonly FilePlan[]): Promise<ClaudeDesktopConfigurationRepair> {
    const changedPlans = plans.filter((plan) => plan.before !== plan.after)
    if (changedPlans.length === 0) return noChangeRepair()

    const attempted: FilePlan[] = []
    try {
      for (const plan of changedPlans) {
        const current = await this.filesystem.read(plan.path)
        if (current !== plan.before) {
          throw new Error('Claude Code Desktop configuration changed during the operation.')
        }
        attempted.push(plan)
        if (plan.after === undefined) await this.filesystem.remove(plan.path)
        else await this.filesystem.write(plan.path, plan.after, true)
      }
    } catch (cause) {
      const restored = await this.restorePlans(attempted).catch(() => false)
      const message = restored
        ? 'Claude Code Desktop configuration could not be updated.'
        : 'Claude Code Desktop configuration could not be updated and rollback could not be completed safely.'
      throw safeConfigurationError(message, cause)
    }

    let rollbackPending = true
    return {
      changed: true,
      rollback: async () => {
        if (!rollbackPending) return
        await this.runExclusive(async () => {
          if (!rollbackPending) return
          let restored: boolean
          try {
            restored = await this.restorePlans(changedPlans)
          } catch (cause) {
            throw safeConfigurationError('Claude Code Desktop configuration rollback failed.', cause)
          }
          if (!restored) {
            throw new Error('Claude Code Desktop configuration changed after repair; rollback was not applied.')
          }
          rollbackPending = false
        })
      },
    }
  }

  private async restorePlans(plans: readonly FilePlan[]): Promise<boolean> {
    const states = await Promise.all(plans.map(async (plan) => ({
      plan,
      current: await this.filesystem.read(plan.path),
    })))
    if (states.some(({ plan, current }) => current !== plan.after && current !== plan.before)) return false

    for (const { plan, current } of states.reverse()) {
      if (current === plan.before) continue
      if (plan.before === undefined) await this.filesystem.remove(plan.path)
      else await this.filesystem.write(plan.path, plan.before, true)
    }
    return true
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pendingOperation.then(operation, operation)
    this.pendingOperation = result.then(() => undefined, () => undefined)
    return result
  }
}

class DefaultClaudeDesktopPolicy implements ClaudeDesktopPolicyPort {
  constructor(private readonly options: Required<Pick<ClaudeDesktopConfigOptions, 'platform' | 'homeDir' | 'environment'>>) {}

  async inspect(_paths: ClaudeDesktopPaths): Promise<ClaudeDesktopPolicyInspection> {
    if (this.options.platform === 'win32') return inspectWindowsPolicy()
    if (this.options.platform === 'darwin') return inspectMacPolicy(this.options.homeDir, this.options.environment)
    if (this.options.platform === 'linux') return inspectLinuxPolicy()
    return { managed: true, reason: 'unsupported-platform' }
  }
}

function noChangeRepair(): ClaudeDesktopConfigurationRepair {
  return { changed: false, rollback: async () => undefined }
}

function buildPlans(
  snapshots: readonly FileSnapshot[],
  target: ClientConnectionTarget,
  models: readonly ClaudeDesktopInferenceModel[],
): FilePlan[] {
  if (snapshots.length !== 4) throw new Error('Incomplete Claude Code Desktop configuration snapshot.')
  const [normal, thirdParty, profile, meta] = snapshots
  return [
    { ...normal, after: renderDeploymentMode(normal.before) },
    { ...thirdParty, after: renderDeploymentMode(thirdParty.before) },
    { ...profile, after: renderProfile(profile.before, target, models) },
    { ...meta, after: renderMeta(meta.before) },
  ]
}

function buildOfficialRestorePlans(snapshots: readonly FileSnapshot[]): FilePlan[] {
  if (snapshots.length !== 4) throw new Error('Incomplete Claude Code Desktop configuration snapshot.')
  const [normal, thirdParty, profile, meta] = snapshots
  return [
    { ...normal, after: renderOfficialDeploymentMode(normal.before) },
    { ...thirdParty, after: renderOfficialThirdPartyConfig(thirdParty.before) },
    { ...profile, after: undefined },
    { ...meta, after: renderOfficialMeta(meta.before) },
  ]
}

function configurationMatches(
  snapshots: readonly FileSnapshot[],
  target: ClientConnectionTarget,
  models: readonly ClaudeDesktopInferenceModel[],
): boolean {
  if (snapshots.length !== 4 || snapshots.some((snapshot) => snapshot.before === undefined)) return false
  const plans = buildPlans(snapshots, target, models)
  return plans.every((plan) => plan.before === plan.after)
}

function renderDeploymentMode(source: string | undefined): string {
  const original = parseJsonObject(source)
  const rendered = { ...original, deploymentMode: '3p' }
  return renderJsonPreservingEquivalentSource(source, original, rendered)
}

function renderOfficialDeploymentMode(source: string | undefined): string {
  const original = parseJsonObject(source)
  const rendered = { ...original, deploymentMode: '1p' }
  return renderJsonPreservingEquivalentSource(source, original, rendered)
}

function renderOfficialThirdPartyConfig(source: string | undefined): string {
  const original = parseJsonObject(source)
  const rendered: Record<string, unknown> = { ...original, deploymentMode: '1p' }
  if (isJsonObject(original.enterpriseConfig)) {
    const enterpriseConfig = { ...original.enterpriseConfig }
    for (const key of [
      'disableDeploymentModeChooser',
      'inferenceGatewayApiKey',
      'inferenceGatewayAuthScheme',
      'inferenceGatewayBaseUrl',
      'inferenceProvider',
    ]) {
      delete enterpriseConfig[key]
    }
    if (Object.keys(enterpriseConfig).length === 0) delete rendered.enterpriseConfig
    else rendered.enterpriseConfig = enterpriseConfig
  }
  return renderJsonPreservingEquivalentSource(source, original, rendered)
}

function renderProfile(
  source: string | undefined,
  target: ClientConnectionTarget,
  models: readonly ClaudeDesktopInferenceModel[],
): string {
  const original = parseJsonObject(source)
  const existingHeaders = original.inferenceCustomHeaders
  if (existingHeaders !== undefined && !isJsonObject(existingHeaders)) {
    throw new Error('Claude Code Desktop inference custom headers must be a JSON object.')
  }
  const rendered: Record<string, unknown> = {
    ...original,
    inferenceProvider: 'gateway',
    inferenceCredentialKind: 'static',
    inferenceGatewayBaseUrl: target.gatewayBaseUrl,
    inferenceGatewayApiKey: target.token,
    inferenceGatewayAuthScheme: 'bearer',
    inferenceCustomHeaders: {
      ...(existingHeaders ?? {}),
      'X-Stone-Client': 'claude-code-desktop',
    },
    coworkEgressAllowedHosts: ['*'],
    disableDeploymentModeChooser: true,
    isClaudeCodeForDesktopEnabled: true,
    modelDiscoveryEnabled: false,
    inferenceModels: models.map((model) => ({ ...model })),
  }
  return renderJsonPreservingEquivalentSource(source, original, rendered)
}

function renderMeta(source: string | undefined): string {
  const original = parseJsonObject(source)
  const existingEntries = original.entries
  if (existingEntries !== undefined && !Array.isArray(existingEntries)) {
    throw new Error('Claude Code Desktop profile metadata entries must be an array.')
  }

  let foundStoneProfile = false
  const entries = (existingEntries ?? []).flatMap((entry) => {
    if (!isJsonObject(entry) || entry.id !== STONE_CLAUDE_DESKTOP_PROFILE_ID) return [entry]
    if (foundStoneProfile) return []
    foundStoneProfile = true
    return [{ ...entry, id: STONE_CLAUDE_DESKTOP_PROFILE_ID, name: STONE_CLAUDE_DESKTOP_PROFILE_NAME }]
  })
  if (!foundStoneProfile) {
    entries.push({ id: STONE_CLAUDE_DESKTOP_PROFILE_ID, name: STONE_CLAUDE_DESKTOP_PROFILE_NAME })
  }
  const rendered = { ...original, entries, appliedId: STONE_CLAUDE_DESKTOP_PROFILE_ID }
  return renderJsonPreservingEquivalentSource(source, original, rendered)
}

function renderOfficialMeta(source: string | undefined): string | undefined {
  if (source === undefined) return undefined
  const original = parseJsonObject(source)
  const rendered: Record<string, unknown> = { ...original }
  const existingEntries = original.entries
  let entries: unknown[] | undefined
  if (Array.isArray(existingEntries)) {
    entries = existingEntries.filter((entry) => (
      !isJsonObject(entry) || entry.id !== STONE_CLAUDE_DESKTOP_PROFILE_ID
    ))
    rendered.entries = entries
  }

  if (original.appliedId === STONE_CLAUDE_DESKTOP_PROFILE_ID) {
    const nextId = entries?.find((entry) => (
      isJsonObject(entry) && typeof entry.id === 'string' && entry.id.trim().length > 0
    ))
    if (isJsonObject(nextId) && typeof nextId.id === 'string') rendered.appliedId = nextId.id
    else delete rendered.appliedId
  }
  return renderJsonPreservingEquivalentSource(source, original, rendered)
}

function parseJsonObject(source: string | undefined): Record<string, unknown> {
  if (source === undefined) return {}
  const parsed = JSON.parse(source) as unknown
  if (!isJsonObject(parsed)) throw new Error('Claude Code Desktop configuration must be a JSON object.')
  return parsed
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function renderJsonPreservingEquivalentSource(
  source: string | undefined,
  original: Record<string, unknown>,
  rendered: Record<string, unknown>,
): string {
  if (source !== undefined && isDeepStrictEqual(original, rendered)) return source
  return `${JSON.stringify(rendered, null, 2)}\n`
}

function validateConnectionTarget(target: ClientConnectionTarget): ClientConnectionTarget {
  const gatewayBaseUrl = target.gatewayBaseUrl.trim()
  if (!gatewayBaseUrl || !target.token) throw new Error('A Stone+ gateway URL and access token are required.')
  let parsed: URL
  try {
    parsed = new URL(gatewayBaseUrl)
  } catch {
    throw new Error('The Stone+ gateway URL is invalid.')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('The Stone+ gateway URL is invalid.')
  }
  return { gatewayBaseUrl, token: target.token }
}

function normalizeModels(models: readonly ClaudeDesktopInferenceModel[]): ClaudeDesktopInferenceModel[] {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('Claude Code Desktop requires at least one reachable full model ID.')
  }

  const names = new Set<string>()
  const familyDefaults = new Set<ClaudeDesktopAnthropicFamilyTier>()
  return models.map((model) => {
    if (!model || typeof model !== 'object') {
      throw new Error('Claude Code Desktop model configuration is invalid.')
    }
    const name = model.name?.trim()
    if (!name || name.length > 256 || containsControlCharacter(name)
      || bareTierAliases.has(name.toLowerCase())) {
      throw new Error('Claude Code Desktop requires full model IDs, not tier aliases.')
    }
    if (names.has(name)) throw new Error('Claude Code Desktop model IDs must be unique.')
    names.add(name)

    const normalized: ClaudeDesktopInferenceModel = { name }
    if (model.labelOverride !== undefined) {
      const labelOverride = model.labelOverride.trim()
      if (!labelOverride || labelOverride.length > 120 || containsControlCharacter(labelOverride)) {
        throw new Error('Claude Code Desktop model label is invalid.')
      }
      normalized.labelOverride = labelOverride
    }
    if (model.anthropicFamilyTier !== undefined) {
      if (!validFamilyTiers.has(model.anthropicFamilyTier)) {
        throw new Error('Claude Code Desktop model tier is invalid.')
      }
      normalized.anthropicFamilyTier = model.anthropicFamilyTier
    }
    if (model.isFamilyDefault !== undefined) {
      if (typeof model.isFamilyDefault !== 'boolean' || (model.isFamilyDefault && !normalized.anthropicFamilyTier)) {
        throw new Error('Claude Code Desktop family default requires a valid model tier.')
      }
      normalized.isFamilyDefault = model.isFamilyDefault
      if (model.isFamilyDefault && normalized.anthropicFamilyTier) {
        if (familyDefaults.has(normalized.anthropicFamilyTier)) {
          throw new Error('Claude Code Desktop can have only one default model per tier.')
        }
        familyDefaults.add(normalized.anthropicFamilyTier)
      }
    }
    return normalized
  })
}

function absoluteEnvironmentPath(value: string | undefined, platform: NodeJS.Platform): string | undefined {
  const candidate = value?.trim()
  if (!candidate) return undefined
  const pathApi = platform === 'win32' ? win32 : posix
  return pathApi.isAbsolute(candidate) ? candidate : undefined
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

export async function inspectWindowsPolicy(
  query: (key: string) => Promise<string[] | null> = queryWindowsPolicy,
): Promise<ClaudeDesktopPolicyInspection> {
  const [machine, user] = await Promise.all([
    query('HKLM\\SOFTWARE\\Policies\\Claude'),
    query('HKCU\\SOFTWARE\\Policies\\Claude'),
  ])
  if (machine === null || user === null) return { managed: true, reason: 'policy-unreadable' }
  return { managed: hasNonUpdatePolicy([...machine, ...user]) }
}

async function queryWindowsPolicy(key: string): Promise<string[] | null> {
  try {
    const stdout = await executeFile('reg.exe', ['query', key])
    return stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.trim().match(/^(.*?)\s+REG_(?:SZ|EXPAND_SZ|DWORD)\s+/i)
      return match?.[1]?.trim() ? [match[1].trim()] : []
    })
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return code === 1 || code === '1' ? [] : null
  }
}

async function inspectMacPolicy(
  homeDir: string,
  environment: NodeJS.ProcessEnv,
): Promise<ClaudeDesktopPolicyInspection> {
  const username = environment.USER?.trim() || posix.basename(homeDir)
  const paths = [
    posix.join('/Library/Managed Preferences', username, 'com.anthropic.claudefordesktop.plist'),
    '/Library/Managed Preferences/com.anthropic.claudefordesktop.plist',
  ]
  const keys: string[] = []
  for (const path of paths) {
    let exists: boolean
    try {
      exists = Boolean(await pathStat(path))
    } catch {
      return { managed: true, reason: 'policy-unreadable' }
    }
    if (!exists) continue
    try {
      const output = await executeFile('plutil', ['-convert', 'json', '-o', '-', path])
      const policy = JSON.parse(output) as unknown
      if (!isJsonObject(policy)) return { managed: true, reason: 'policy-invalid' }
      keys.push(...Object.keys(policy))
    } catch {
      return { managed: true, reason: 'policy-unreadable' }
    }
  }
  return { managed: hasNonUpdatePolicy(keys) }
}

async function inspectLinuxPolicy(): Promise<ClaudeDesktopPolicyInspection> {
  const path = '/etc/claude-desktop/managed-settings.json'
  let source: string | undefined
  try {
    source = await readTextIfPresent(path)
  } catch {
    return { managed: true, reason: 'policy-unreadable' }
  }
  if (source === undefined) return { managed: false }
  try {
    const policy = JSON.parse(source) as unknown
    if (!isJsonObject(policy)) return { managed: true, reason: 'policy-invalid' }
    return { managed: hasNonUpdatePolicy(Object.keys(policy)) }
  } catch {
    return { managed: true, reason: 'policy-invalid' }
  }
}

function hasNonUpdatePolicy(keys: readonly string[]): boolean {
  return keys.some((key) => !updateOnlyPolicyKeys.has(key.trim().toLowerCase()))
}

function executeFile(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

function safeConfigurationError(message: string, cause: unknown): Error {
  // File/parser errors can include configuration excerpts. Never attach them:
  // the Stone-owned profile contains the bearer credential.
  void cause
  return new Error(message)
}
