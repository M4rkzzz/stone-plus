import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve, win32 as win32Path } from 'node:path'
import { atomicWriteFile, readTextIfPresent } from '../client-config/filesystem'

export const SUPPORTED_DEEPSEEK_HARNESS_VERSION = '0.1.0-rc.6'
export const SUPPORTED_DSH_TERMINAL_BASH_VERSION = '0.1.0-rc.6'
/** SHA-256 of the upstream dsh-terminal-bash@0.1.0-rc.6 source Stone+ patches. */
export const SUPPORTED_DSH_TERMINAL_BASH_SOURCE_SHA256 = 'DE1DBFD60B4034E74A2825679A3066802AC45D2F510A62A706FA1E5A83112F6C'
export const STONE_DSH_CONTROLLED_PROMPT = '__DSH_PERSISTENT_BASH_PROMPT__ '
export const STONE_DEEPSEEK_HARNESS_PROVIDER_ID = 'deepseek-official'

export interface DeepSeekHarnessCompanionInstallOptions {
  gatewayBaseUrl: string
  credentialFile: string
  /** The executable Stone+ is about to launch, used to locate the managed DSH package. */
  executablePath?: string
}

export interface DeepSeekHarnessCompanionInstallResult {
  patchPath: string
  changed: boolean
}

export interface DeepSeekHarnessCompanionPort {
  ensureInstalled(options: DeepSeekHarnessCompanionInstallOptions): Promise<DeepSeekHarnessCompanionInstallResult>
}

/**
 * Installs a small host-side Cordis plugin next to DSH's own data. The official
 * DSH package remains untouched; Stone+ adds the plugin as a final, disposable
 * profile overlay only for processes that Stone+ launches.
 */
export class DeepSeekHarnessCompanionInstaller implements DeepSeekHarnessCompanionPort {
  readonly directory: string
  readonly pluginPath: string
  readonly patchPath: string

  constructor(deepSeekHarnessHome: string) {
    this.directory = join(resolve(deepSeekHarnessHome), 'stoneplus', 'model-family-bridge')
    this.pluginPath = join(this.directory, 'index.mjs')
    this.patchPath = join(this.directory, 'cordis.patch.yml')
  }

  async ensureInstalled(
    options: DeepSeekHarnessCompanionInstallOptions,
  ): Promise<DeepSeekHarnessCompanionInstallResult> {
    const gatewayBaseUrl = normalizeGatewayBaseUrl(options.gatewayBaseUrl)
    const patch = companionPatch({
      pluginUrl: pathToFileURL(this.pluginPath).href,
      gatewayBaseUrl,
      credentialFile: resolve(options.credentialFile),
      providerId: STONE_DEEPSEEK_HARNESS_PROVIDER_ID,
    })
    const changes = await Promise.all([
      writeIfChanged(this.pluginPath, DEEPSEEK_HARNESS_COMPANION_SOURCE),
      writeIfChanged(this.patchPath, patch),
    ])
    let kernelChanged = false
    if (options.executablePath) {
      kernelChanged = await ensureDshTerminalBashKernel(options.executablePath)
    }
    return { patchPath: this.patchPath, changed: changes.some(Boolean) || kernelChanged }
  }
}

/**
 * Apply the small readiness fix from the upstream dsh-terminal-bash source.
 * This is deliberately a source transform with an exact upstream hash guard:
 * Stone+ must never rewrite an unknown third-party version in place.
 */
export function patchDshTerminalBashSource(source: string): string {
  const desiredPrompt = `const CONTROLLED_PROMPT = ${JSON.stringify(STONE_DSH_CONTROLLED_PROMPT)};`
  const desiredTail = 'const remaining = Math.max(0, CONTROLLED_PROMPT.length + 1 - this.promptTail.length);'
  if (source.includes(desiredPrompt) && source.includes(desiredTail)) return source

  const prompt = 'const CONTROLLED_PROMPT = "dsh> ";'
  const tail = 'const remaining = Math.max(0, 6 - this.promptTail.length);'
  if (countOccurrences(source, prompt) !== 1 || countOccurrences(source, tail) !== 1) {
    throw new Error('Stone+ DSH kernel patch does not match the supported dsh-terminal-bash source.')
  }
  return source
    .replace(prompt, desiredPrompt)
    .replace(tail, desiredTail)
}

async function ensureDshTerminalBashKernel(executablePath: string): Promise<boolean> {
  const packageSource = await findDshTerminalBashSource(executablePath)
  if (!packageSource) {
    throw new Error('Stone+ could not locate the managed dsh-terminal-bash package for the DSH executable.')
  }
  const packageMetadata = await readJsonFile(join(dirname(dirname(packageSource)), 'package.json'))
  if (packageMetadata?.name !== '@deepseek-ai/dsh-terminal-bash'
    || packageMetadata.version !== SUPPORTED_DSH_TERMINAL_BASH_VERSION) {
    throw new Error(
      `Stone+ DSH kernel patch supports @deepseek-ai/dsh-terminal-bash@${SUPPORTED_DSH_TERMINAL_BASH_VERSION}; `
      + `found ${String(packageMetadata?.name ?? 'unknown')}@${String(packageMetadata?.version ?? 'unknown')}.`,
    )
  }

  const source = await readFile(packageSource, 'utf8')
  if (source.includes(`const CONTROLLED_PROMPT = ${JSON.stringify(STONE_DSH_CONTROLLED_PROMPT)};`)
    && source.includes('const remaining = Math.max(0, CONTROLLED_PROMPT.length + 1 - this.promptTail.length);')) {
    return false
  }
  const sourceHash = createHash('sha256').update(source).digest('hex').toUpperCase()
  if (sourceHash !== SUPPORTED_DSH_TERMINAL_BASH_SOURCE_SHA256) {
    throw new Error(
      `Stone+ refused to patch an unrecognized dsh-terminal-bash source (SHA-256 ${sourceHash}). `
      + 'Update Stone+ before starting DeepSeek Harness.',
    )
  }
  const patched = patchDshTerminalBashSource(source)
  await atomicWriteFile(packageSource, patched, randomUUID, false)
  return true
}

async function findDshTerminalBashSource(executablePath: string): Promise<string | undefined> {
  let directory = dirname(resolve(executablePath))
  for (let depth = 0; depth < 8; depth += 1) {
    const candidates = [
      join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-terminal-bash', 'lib', 'index.js'),
      join(directory, 'node_modules', '@deepseek-ai', 'dsh-terminal-bash', 'lib', 'index.js'),
      join(directory, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-terminal-bash', 'lib', 'index.js'),
      join(directory, 'lib', 'node_modules', '@deepseek-ai', 'dsh-terminal-bash', 'lib', 'index.js'),
    ]
    for (const candidate of candidates) {
      if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function countOccurrences(source: string, needle: string): number {
  let count = 0
  let offset = 0
  while (true) {
    const index = source.indexOf(needle, offset)
    if (index < 0) return count
    count += 1
    offset = index + needle.length
  }
}

/** Add Stone's repeatable DSH overlay without removing user-supplied overlays. */
export function withDeepSeekHarnessCompanionPatch(
  current: readonly string[],
  patchPath: string,
): string[] {
  // Keep the path dialect supplied by the managed profile.  A Windows
  // profile may be prepared on a POSIX CI host; native `resolve()` would
  // incorrectly prefix that absolute path with the CI workspace.
  const normalizedPatch = normalizeManagedPath(patchPath)
  const args: string[] = []
  const userPatches: string[] = []
  for (let index = 0; index < current.length; index += 1) {
    const argument = current[index]
    if (argument === '--patch' && index + 1 < current.length) {
      if (samePath(current[index + 1], normalizedPatch)) {
        index += 1
        continue
      }
      userPatches.push(argument, current[index + 1])
      index += 1
      continue
    }
    if (argument.startsWith('--patch=') && samePath(argument.slice('--patch='.length), normalizedPatch)) {
      continue
    }
    if (argument.startsWith('--patch=')) {
      userPatches.push(argument)
      continue
    }
    args.push(argument)
  }

  if (args.length === 0) {
    return [
      'web',
      ...userPatches,
      '--patch',
      normalizedPatch,
      '--host',
      '127.0.0.1',
      '--port',
      '3080',
    ]
  }
  const webIndex = args.indexOf('web')
  if (webIndex >= 0) {
    args.splice(webIndex + 1, 0, ...userPatches, '--patch', normalizedPatch)
    return args
  }
  return ['web', ...userPatches, '--patch', normalizedPatch, ...args]
}

function companionPatch(input: {
  pluginUrl: string
  gatewayBaseUrl: string
  credentialFile: string
  providerId: string
}): string {
  return [
    '# Stone+ managed overlay. User profile patches are not modified.',
    '- id: llm-deepseek',
    "  name: '@deepseek-ai/dsh-llm-deepseek'",
    '  disabled: true',
    '# DSH ships these safety features disabled in the web profile. Stone+ enables',
    '# them for managed sessions so imported Codex histories compact before the',
    '# upstream Responses item limit is reached. The engine preserves complete',
    '# tool-call/result pairs while replacing only an acknowledged old range.',
    '- id: compaction-basic',
    "  name: '@deepseek-ai/dsh-compaction-basic'",
    '  disabled: false',
    '  config:',
    '    auto: true',
    '    thresholdRatio: 0.55',
    '    retainRatio: 0.10',
    '    compactionRetries: 2',
    '    maxOverflowRetries: 2',
    '- id: command-compact',
    "  name: '@deepseek-ai/dsh-command-compact'",
    '  disabled: false',
    '- id: tool-result-pruner',
    "  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
    '  disabled: false',
    '- insert:',
    '    - id: stoneplus-model-family-bridge',
    `      name: ${JSON.stringify(input.pluginUrl)}`,
    '      config:',
    `        gatewayBaseUrl: ${JSON.stringify(input.gatewayBaseUrl)}`,
    `        credentialFile: ${JSON.stringify(input.credentialFile)}`,
    `        providerId: ${JSON.stringify(input.providerId)}`,
    `        supportedDshVersion: ${JSON.stringify(SUPPORTED_DEEPSEEK_HARNESS_VERSION)}`,
    '',
  ].join('\n')
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  if (await readTextIfPresent(path) === content) return false
  await atomicWriteFile(path, content, randomUUID, false)
  return true
}

function normalizeGatewayBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !isLoopbackHostname(url.hostname)) {
    throw new Error('DeepSeek Harness companion requires a loopback Stone+ gateway URL.')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  url.search = ''
  url.hash = ''
  return url.href.replace(/\/$/, '')
}

function isLoopbackHostname(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === '::1') return true
  const octets = normalized.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

function samePath(left: string, right: string): boolean {
  // Managed profiles can be inspected by a non-Windows CI/runtime while
  // retaining their original Windows paths.  Node's host-native `resolve`
  // would otherwise turn `C:\\...` into a POSIX-relative path, causing the
  // same overlay to be duplicated and breaking launch argument persistence.
  const windowsPath = /^(?:[A-Za-z]:[\\/]|\\\\)/
  const useWindowsDialect = process.platform === 'win32' || windowsPath.test(left) || windowsPath.test(right)
  const normalizedLeft = useWindowsDialect ? win32Path.resolve(left) : resolve(left)
  const normalizedRight = useWindowsDialect ? win32Path.resolve(right) : resolve(right)
  return useWindowsDialect
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function normalizeManagedPath(value: string): string {
  const windowsPath = /^(?:[A-Za-z]:[\\/]|\\\\)/
  return windowsPath.test(value)
    ? win32Path.resolve(value)
    : resolve(value)
}

export const DEEPSEEK_HARNESS_COMPANION_SOURCE = String.raw`import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const name = 'stoneplus-model-family-bridge'
export const inject = ['apiProxy']

const ENDPOINT_PATH = '/deepseek-harness/stone/session-models'
const FETCH_TIMEOUT_MS = 1200

export async function apply(ctx, config = {}) {
  const actualVersion = await findDshVersion()
  if (!config.supportedDshVersion || actualVersion !== config.supportedDshVersion) {
    ctx.logger.warn(
      'Stone+ model-family filtering is disabled for this DSH version (expected '
      + String(config.supportedDshVersion || 'unknown') + ', found '
      + String(actualVersion || 'unknown') + '). Gateway enforcement remains active.',
    )
    return
  }

  const sessions = ctx.apiProxy && ctx.apiProxy.sessions
  if (!sessions || typeof sessions.models !== 'function' || typeof sessions.selectModel !== 'function') {
    ctx.logger.warn('Stone+ model-family filtering is unavailable because the DSH session API changed.')
    return
  }
  if (typeof config.providerId !== 'string' || !config.providerId) {
    ctx.logger.warn('Stone+ model-family filtering has no managed DSH provider identity.')
    return
  }
  const token = await resolveGatewayToken(config.credentialFile)
  if (!token) {
    ctx.logger.warn('Stone+ model-family filtering could not read the local DSH route credential.')
    return
  }

  const originalModels = sessions.models
  const originalSelectModel = sessions.selectModel
  const wrappedModels = async function (request) {
    const response = await originalModels.call(sessions, request)
    if (!response || !response.result || response.result.ok !== true) return response
    const sessionId = request && request.payload && request.payload.sessionId
    if (typeof sessionId !== 'string') return response
    const directory = await queryStone(config.gatewayBaseUrl, token, sessionId)
    if (!directory || !Array.isArray(directory.allowedModels)) return response
    return filterModelsResponse(response, directory.allowedModels, config.providerId)
  }

  const wrappedSelectModel = async function (request) {
    const payload = request && request.payload
    if (!payload || typeof payload.sessionId !== 'string' || typeof payload.model !== 'string') {
      return originalSelectModel.call(sessions, request)
    }
    if (payload.provider !== config.providerId) {
      return modelUnavailable(
        request,
        payload,
        'Stone+ managed sessions can only select models from the Stone+ provider.',
      )
    }
    const decision = await selectThroughStone(
      config.gatewayBaseUrl,
      token,
      payload.sessionId,
      payload.model,
    )
    if (decision && decision.rejected) {
      return modelUnavailable(request, payload, decision.message)
    }
    return originalSelectModel.call(sessions, request)
  }

  ctx.effect(() => {
    sessions.models = wrappedModels
    sessions.selectModel = wrappedSelectModel
    return () => {
      if (sessions.models === wrappedModels) sessions.models = originalModels
      if (sessions.selectModel === wrappedSelectModel) sessions.selectModel = originalSelectModel
    }
  }, name)
}

function modelUnavailable(request, payload, message) {
  return {
    rpcId: request.rpcId,
    result: {
      ok: false,
      error: {
        code: 'model-unavailable',
        message,
        details: { provider: payload.provider, model: payload.model },
      },
    },
  }
}

async function queryStone(baseUrl, token, sessionId) {
  try {
    const url = endpointUrl(baseUrl)
    url.searchParams.set('session_id', sessionId)
    const response = await boundedFetch(url, {
      headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
    })
    if (!response.ok) return undefined
    const payload = await response.json()
    return validDirectory(payload) ? payload : undefined
  } catch {
    return undefined
  }
}

async function selectThroughStone(baseUrl, token, sessionId, model) {
  try {
    const response = await boundedFetch(endpointUrl(baseUrl), {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId, model }),
    })
    if (response.ok) return { rejected: false }
    if (response.status !== 409 && response.status !== 422) return undefined
    const payload = await response.json().catch(() => undefined)
    return {
      rejected: true,
      message: payload && payload.error && typeof payload.error.message === 'string'
        ? payload.error.message
        : 'This session cannot switch to the selected model family.',
    }
  } catch {
    return undefined
  }
}

function endpointUrl(baseUrl) {
  return new URL(ENDPOINT_PATH, String(baseUrl).replace(/\/+$/, '') + '/')
}

async function boundedFetch(url, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'error' })
  } finally {
    clearTimeout(timer)
  }
}

function validDirectory(value) {
  return value && typeof value === 'object'
    && (value.family === null || value.family === 'gpt' || value.family === 'deepseek')
    && Array.isArray(value.allowedModels)
    && value.allowedModels.every((model) => typeof model === 'string')
}

function filterModelsResponse(response, allowedModels, providerId) {
  const allowed = new Set(allowedModels)
  const value = response && response.result && response.result.value
  if (!value || !Array.isArray(value.groups)) return response
  const groups = value.groups
    .filter((group) => group && group.id === providerId)
    .map((group) => ({
      ...group,
      models: Array.isArray(group.models)
        ? group.models.filter((model) => model && allowed.has(model.id))
        : [],
    }))
    .filter((group) => group.models.length > 0)
  const currentAllowed = value.current
    && value.current.provider === providerId
    && allowed.has(value.current.model)
  return {
    ...response,
    result: {
      ...response.result,
      value: {
        ...value,
        groups,
        failures: Array.isArray(value.failures)
          ? value.failures.filter((failure) => failure && failure.id === providerId)
          : [],
        routable: Boolean(value.routable && currentAllowed),
      },
    },
  }
}

async function resolveGatewayToken(credentialFile) {
  const environmentToken = typeof process.env.DEEPSEEK_API_KEY === 'string'
    ? process.env.DEEPSEEK_API_KEY.trim()
    : ''
  if (environmentToken) return environmentToken
  if (typeof credentialFile !== 'string' || !credentialFile) return undefined
  try {
    const text = await readFile(credentialFile, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.*)\s*$/.exec(line)
      if (!match) continue
      return parseDotEnvValue(match[1])
    }
  } catch {}
  return undefined
}

function parseDotEnvValue(raw) {
  const value = raw.trim()
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    try { return JSON.parse(value) } catch { return undefined }
  }
  if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
    return value.slice(1, -1)
  }
  return value.split(/\s+#/, 1)[0].trim() || undefined
}

async function findDshVersion() {
  const entry = typeof process.argv[1] === 'string' ? process.argv[1] : ''
  if (!entry) return undefined
  let directory = dirname(entry)
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (metadata && metadata.name === '@deepseek-ai/dsh' && typeof metadata.version === 'string') {
        return metadata.version
      }
    } catch {}
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

export const internals = { filterModelsResponse, validDirectory }
`
