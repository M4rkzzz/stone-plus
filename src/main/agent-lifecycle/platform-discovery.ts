import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { AgentProcessControl, AgentTarget } from '@shared/agent-lifecycle'

export type DiscoverableAgentTarget = AgentTarget
type DiscoverableCliTarget = 'codex-cli' | 'claude-code' | 'gemini-cli' | 'grok-build' | 'deepseek-harness'

export type AgentExecutableSource =
  | 'command-path'
  | 'well-known-path'
  | 'windows-app'
  | 'macos-app'
  | 'unavailable'

export interface AgentExecutableDiscovery {
  target: DiscoverableAgentTarget
  platform: NodeJS.Platform
  supported: boolean
  installed: boolean
  /** Installed product/package version when the platform exposes it without launching the app. */
  version?: string
  /** A directly executable file. Store-app installations can omit this. */
  executablePath?: string
  /** An OS launch identifier such as a Windows AppsFolder application ID. */
  launchTarget?: string
  source: AgentExecutableSource
  /** CLI processes are deliberately controllable only when Stone+ launched them. */
  processControl: AgentProcessControl
  inspectedPaths: string[]
}

export interface PlatformCommandResult {
  stdout: string
  stderr: string
}

export interface PlatformDiscoveryOptions {
  platform?: NodeJS.Platform
  homeDir?: string
  /** Project directory whose local node_modules/.bin shims are eligible. */
  workingDirectory?: string
  environment?: NodeJS.ProcessEnv
  fileExists?: (path: string) => Promise<boolean>
  readDirectoryNames?: (path: string) => Promise<string[]>
  findCommand?: (name: string, platform: NodeJS.Platform) => Promise<string[]>
  runCommand?: (file: string, args: string[]) => Promise<PlatformCommandResult>
}

const windowsCodexAppId = 'OpenAI.Codex_2p2nqsd0c76g0!App'

/**
 * Finds a supported Agent installation without inspecting or terminating any
 * running process. In particular, a CLI found on PATH is not considered owned
 * by Stone+; lifecycle code must use its managed-process registry to close it.
 */
export async function discoverAgentExecutable(
  target: DiscoverableAgentTarget,
  options: PlatformDiscoveryOptions = {},
): Promise<AgentExecutableDiscovery> {
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? homedir()
  const workingDirectory = options.workingDirectory ?? process.cwd()
  const environment = options.environment ?? process.env
  const fileExists = options.fileExists ?? isExistingFile
  const readDirectoryNames = options.readDirectoryNames ?? directoryNames
  const findCommand = options.findCommand ?? findCommandOnPath
  const runCommand = options.runCommand ?? executeCommand

  if (target === 'codex-desktop') {
    return discoverCodexDesktop({ platform, homeDir, workingDirectory, environment, fileExists, runCommand })
  }

  if (target === 'claude-code-desktop') {
    return discoverClaudeCodeDesktop({ platform, homeDir, workingDirectory, environment, fileExists, runCommand })
  }

  if (target === 'claude-code-vsc') {
    return discoverClaudeCodeVsc({ platform, homeDir, workingDirectory, environment, fileExists, readDirectoryNames })
  }

  if (isDiscoverableCliTarget(target)) {
    return discoverCli(target, { platform, homeDir, workingDirectory, environment, fileExists, findCommand })
  }
  return unsupported(target, platform)
}

interface ResolvedDiscoveryOptions {
  platform: NodeJS.Platform
  homeDir: string
  workingDirectory: string
  environment: NodeJS.ProcessEnv
  fileExists: (path: string) => Promise<boolean>
}

async function discoverCli(
  target: DiscoverableCliTarget,
  options: ResolvedDiscoveryOptions & {
    findCommand: (name: string, platform: NodeJS.Platform) => Promise<string[]>
  },
): Promise<AgentExecutableDiscovery> {
  if (!isDesktopPlatform(options.platform)) return unsupported(target, options.platform)
  const command = cliCommandName(target)
  const inspectedPaths: string[] = []

  let commandPaths: string[] = []
  try {
    commandPaths = await options.findCommand(command, options.platform)
  } catch {
    // A missing/broken PATH lookup is not fatal; well-known locations remain useful.
  }
  // where.exe often lists extensionless npm shims before .cmd/.exe. Prefer
  // paths that CreateProcess (or our cmd.exe wrapper) can actually launch.
  const orderedCommandPaths = orderWindowsLaunchCandidates(commandPaths, options.platform)
  const pathMatch = await firstExisting(orderedCommandPaths, options.fileExists, inspectedPaths, options.platform)
  if (pathMatch) return installed(target, options.platform, pathMatch, 'command-path', inspectedPaths, 'managed-only')

  const candidates = cliWellKnownPaths(target, options)
  const knownMatch = await firstExisting(candidates, options.fileExists, inspectedPaths, options.platform)
  if (knownMatch) return installed(target, options.platform, knownMatch, 'well-known-path', inspectedPaths, 'managed-only')

  return {
    target,
    platform: options.platform,
    supported: true,
    installed: false,
    source: 'unavailable',
    processControl: 'managed-only',
    inspectedPaths,
  }
}

async function discoverClaudeCodeDesktop(
  options: ResolvedDiscoveryOptions & {
    runCommand: (file: string, args: string[]) => Promise<PlatformCommandResult>
  },
): Promise<AgentExecutableDiscovery> {
  const target = 'claude-code-desktop' as const
  const { platform, homeDir, fileExists, runCommand } = options
  if (!isDesktopPlatform(platform)) return unsupported(target, platform)

  if (platform === 'win32') {
    const appPackage = await discoverWindowsClaudeDesktopApp(runCommand)
    if (!appPackage) {
      return {
        target, platform, supported: true, installed: false,
        source: 'unavailable', processControl: 'unavailable', inspectedPaths: [],
      }
    }
    return {
      target,
      platform,
      supported: true,
      installed: true,
      launchTarget: 'claude://code/new',
      source: 'windows-app',
      processControl: 'unavailable',
      inspectedPaths: appPackage.installLocation ? [appPackage.installLocation] : [],
    }
  }

  const candidates = platform === 'darwin'
    ? [
        '/Applications/Claude.app/Contents/MacOS/Claude',
        posix.join(homeDir, 'Applications', 'Claude.app', 'Contents', 'MacOS', 'Claude'),
      ]
    : ['/usr/bin/claude-desktop']
  const inspectedPaths: string[] = []
  const match = await firstExisting(candidates, fileExists, inspectedPaths, platform)
  if (!match) {
    return {
      target, platform, supported: true, installed: false,
      source: 'unavailable', processControl: 'unavailable', inspectedPaths,
    }
  }
  return {
    target,
    platform,
    supported: true,
    installed: true,
    executablePath: match,
    launchTarget: 'claude://code/new',
    source: platform === 'darwin' ? 'macos-app' : 'well-known-path',
    processControl: 'unavailable',
    inspectedPaths,
  }
}

async function discoverClaudeCodeVsc(
  options: ResolvedDiscoveryOptions & {
    readDirectoryNames: (path: string) => Promise<string[]>
  },
): Promise<AgentExecutableDiscovery> {
  const target = 'claude-code-vsc' as const
  const { platform, homeDir, readDirectoryNames } = options
  if (!isDesktopPlatform(platform)) return unsupported(target, platform)
  const pathApi = platform === 'win32' ? win32 : posix
  const channels = [
    {
      root: pathApi.join(homeDir, '.vscode', 'extensions'),
      launchTarget: 'vscode://anthropic.claude-code/open',
    },
    {
      root: pathApi.join(homeDir, '.vscode-insiders', 'extensions'),
      launchTarget: 'vscode-insiders://anthropic.claude-code/open',
    },
  ] as const
  const inspectedPaths: string[] = []

  for (const channel of channels) {
    inspectedPaths.push(channel.root)
    let names: string[]
    try {
      names = await readDirectoryNames(channel.root)
    } catch {
      continue
    }
    const extension = names
      .filter(isOfficialClaudeCodeExtensionDirectory)
      .sort((left, right) => right.localeCompare(left, 'en-US'))
      .at(0)
    if (!extension) continue
    const extensionPath = pathApi.join(channel.root, extension)
    inspectedPaths.push(extensionPath)
    return {
      target,
      platform,
      supported: true,
      installed: true,
      launchTarget: channel.launchTarget,
      source: 'well-known-path',
      processControl: 'unavailable',
      inspectedPaths: uniquePaths(inspectedPaths, platform),
    }
  }

  return {
    target, platform, supported: true, installed: false,
    source: 'unavailable', processControl: 'unavailable',
    inspectedPaths: uniquePaths(inspectedPaths, platform),
  }
}

async function discoverCodexDesktop(
  options: ResolvedDiscoveryOptions & {
    runCommand: (file: string, args: string[]) => Promise<PlatformCommandResult>
  },
): Promise<AgentExecutableDiscovery> {
  const { platform, fileExists } = options
  if (platform === 'linux' || !isDesktopPlatform(platform)) return unsupported('codex-desktop', platform)
  const inspectedPaths: string[] = []

  if (platform === 'darwin') {
    const match = await firstExisting(macCodexDesktopPaths(options.homeDir), fileExists, inspectedPaths, platform)
    if (match) return installed('codex-desktop', platform, match, 'macos-app', inspectedPaths, 'full')
    return {
      target: 'codex-desktop', platform, supported: true, installed: false,
      source: 'unavailable', processControl: 'full', inspectedPaths,
    }
  }

  const match = await firstExisting(windowsCodexDesktopPaths(options), fileExists, inspectedPaths, platform)
  if (match) return installed('codex-desktop', platform, match, 'well-known-path', inspectedPaths, 'full')

  const storeApp = await discoverWindowsCodexApp(options.runCommand)
  if (storeApp) {
    if (storeApp.executablePath) inspectedPaths.push(storeApp.executablePath)
    return {
      target: 'codex-desktop', platform, supported: true, installed: true,
      ...(storeApp.executablePath ? { executablePath: storeApp.executablePath } : {}),
      ...(storeApp.version ? { version: storeApp.version } : {}),
      launchTarget: storeApp.launchTarget,
      source: 'windows-app', processControl: 'full', inspectedPaths: uniquePaths(inspectedPaths, platform),
    }
  }
  return {
    target: 'codex-desktop', platform, supported: true, installed: false,
    source: 'unavailable', processControl: 'full', inspectedPaths,
  }
}

export function cliWellKnownPaths(
  target: DiscoverableCliTarget,
  options: Pick<ResolvedDiscoveryOptions, 'platform' | 'homeDir' | 'environment'> & { workingDirectory?: string },
): string[] {
  const { platform, homeDir, environment } = options
  const workingDirectory = options.workingDirectory ?? process.cwd()
  const pathApi = platform === 'win32' ? win32 : posix
  const name = cliCommandName(target)
  if (platform === 'win32') {
    const names = [`${name}.exe`, `${name}.com`, `${name}.cmd`, `${name}.bat`, `${name}.ps1`]
    const programFilesX86 = environment['ProgramFiles(x86)']
    const directories = [
      pathApi.join(workingDirectory, 'node_modules', '.bin'),
      environment.APPDATA ? pathApi.join(environment.APPDATA, 'npm') : '',
      environment.LOCALAPPDATA ? pathApi.join(environment.LOCALAPPDATA, 'npm') : '',
      environment.NPM_CONFIG_PREFIX ?? environment.npm_config_prefix ?? '',
      environment.PNPM_HOME ?? '',
      environment.VOLTA_HOME ? pathApi.join(environment.VOLTA_HOME, 'bin') : '',
      environment.BUN_INSTALL ? pathApi.join(environment.BUN_INSTALL, 'bin') : '',
      environment.NVM_SYMLINK ?? '',
      environment.LOCALAPPDATA ? pathApi.join(environment.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : '',
      pathApi.join(homeDir, '.local', 'bin'),
      target === 'grok-build' ? pathApi.join(homeDir, '.grok', 'bin') : '',
      target === 'codex-cli' && environment.LOCALAPPDATA
        ? pathApi.join(environment.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin')
        : '',
      environment.LOCALAPPDATA ? pathApi.join(environment.LOCALAPPDATA, 'Programs', name) : '',
      environment.ProgramFiles ? pathApi.join(environment.ProgramFiles, 'nodejs') : '',
      environment.ProgramFiles ? pathApi.join(environment.ProgramFiles, name) : '',
      programFilesX86 ? pathApi.join(programFilesX86, 'nodejs') : '',
    ].filter(Boolean)
    return uniquePaths(directories.flatMap((directory) => names.map((file) => pathApi.join(directory, file))), platform)
  }

  return uniquePaths([
    pathApi.join(workingDirectory, 'node_modules', '.bin', name),
    ...(environment.NPM_CONFIG_PREFIX || environment.npm_config_prefix
      ? [pathApi.join(environment.NPM_CONFIG_PREFIX ?? environment.npm_config_prefix!, 'bin', name)]
      : []),
    ...(environment.PNPM_HOME ? [pathApi.join(environment.PNPM_HOME, name)] : []),
    ...(environment.VOLTA_HOME ? [pathApi.join(environment.VOLTA_HOME, 'bin', name)] : []),
    ...(environment.BUN_INSTALL ? [pathApi.join(environment.BUN_INSTALL, 'bin', name)] : []),
    ...(target === 'grok-build' ? [pathApi.join(homeDir, '.grok', 'bin', name)] : []),
    pathApi.join(homeDir, '.local', 'bin', name),
    pathApi.join(homeDir, '.npm-global', 'bin', name),
    '/usr/local/bin/' + name,
    ...(platform === 'darwin' ? ['/opt/homebrew/bin/' + name] : []),
    '/usr/bin/' + name,
  ], platform)
}

function windowsCodexDesktopPaths(options: Pick<ResolvedDiscoveryOptions, 'homeDir' | 'environment'>): string[] {
  const { homeDir, environment } = options
  return uniquePaths([
    environment.LOCALAPPDATA ? win32.join(environment.LOCALAPPDATA, 'Programs', 'Codex', 'Codex.exe') : '',
    environment.LOCALAPPDATA ? win32.join(environment.LOCALAPPDATA, 'Programs', 'ChatGPT', 'ChatGPT.exe') : '',
    environment.ProgramFiles ? win32.join(environment.ProgramFiles, 'Codex', 'Codex.exe') : '',
    win32.join(homeDir, 'AppData', 'Local', 'Programs', 'Codex', 'Codex.exe'),
  ].filter(Boolean), 'win32')
}

function macCodexDesktopPaths(homeDir: string): string[] {
  return [
    '/Applications/Codex.app/Contents/MacOS/Codex',
    '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    posix.join(homeDir, 'Applications', 'Codex.app', 'Contents', 'MacOS', 'Codex'),
    posix.join(homeDir, 'Applications', 'ChatGPT.app', 'Contents', 'MacOS', 'ChatGPT'),
  ]
}

async function discoverWindowsCodexApp(
  runCommand: (file: string, args: string[]) => Promise<PlatformCommandResult>,
): Promise<{ launchTarget: string; executablePath?: string; version?: string } | undefined> {
  const script = [
    "$package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1;",
    'if (-not $package) { exit 0 };',
    "$executable = Join-Path $package.InstallLocation 'app\\ChatGPT.exe';",
    `[Console]::Out.Write('${windowsCodexAppId}' + [Environment]::NewLine + $(if (Test-Path -LiteralPath $executable) { $executable } else { '' }) + [Environment]::NewLine + $package.Version.ToString());`,
  ].join(' ')
  try {
    const result = await runCommand('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ])
    const [launchTarget, executablePath, version] = result.stdout.split(/\r?\n/).map((value) => value.trim())
    if (!launchTarget) return undefined
    return {
      launchTarget,
      ...(executablePath ? { executablePath } : {}),
      ...(version ? { version } : {}),
    }
  } catch {
    return undefined
  }
}

async function discoverWindowsClaudeDesktopApp(
  runCommand: (file: string, args: string[]) => Promise<PlatformCommandResult>,
): Promise<{ packageFamilyName: string; installLocation?: string } | undefined> {
  const script = [
    "$package = Get-AppxPackage -Name 'Claude' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1;",
    'if (-not $package) { exit 0 };',
    '[Console]::Out.WriteLine($package.PackageFamilyName);',
    '[Console]::Out.WriteLine($package.InstallLocation);',
  ].join(' ')
  try {
    const result = await runCommand('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ])
    const [packageFamilyName, installLocation] = result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
    if (!packageFamilyName) return undefined
    return { packageFamilyName, ...(installLocation ? { installLocation } : {}) }
  } catch {
    return undefined
  }
}

function cliCommandName(target: DiscoverableCliTarget): string {
  if (target === 'codex-cli') return 'codex'
  if (target === 'claude-code') return 'claude'
  if (target === 'gemini-cli') return 'gemini'
  return target === 'grok-build' ? 'grok' : 'dsh'
}

function isDiscoverableCliTarget(target: DiscoverableAgentTarget): target is DiscoverableCliTarget {
  return target === 'codex-cli'
    || target === 'claude-code'
    || target === 'gemini-cli'
    || target === 'grok-build'
    || target === 'deepseek-harness'
}

function isOfficialClaudeCodeExtensionDirectory(name: string): boolean {
  return /^anthropic\.claude-code-\d+\.\d+\.\d+(?:-[0-9a-z][0-9a-z.-]*)?$/i.test(name)
}

function isDesktopPlatform(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux'
}

function unsupported(target: DiscoverableAgentTarget, platform: NodeJS.Platform): AgentExecutableDiscovery {
  return {
    target, platform, supported: false, installed: false, source: 'unavailable',
    processControl: 'unavailable', inspectedPaths: [],
  }
}

function installed(
  target: DiscoverableAgentTarget,
  platform: NodeJS.Platform,
  executablePath: string,
  source: AgentExecutableSource,
  inspectedPaths: string[],
  processControl: AgentExecutableDiscovery['processControl'],
): AgentExecutableDiscovery {
  return {
    target, platform, supported: true, installed: true, executablePath, source,
    processControl, inspectedPaths: uniquePaths(inspectedPaths, platform),
  }
}

async function firstExisting(
  candidates: readonly string[],
  fileExists: (path: string) => Promise<boolean>,
  inspectedPaths: string[],
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  for (const candidate of uniquePaths(candidates.filter(Boolean), platform)) {
    inspectedPaths.push(candidate)
    try {
      if (await fileExists(candidate)) return candidate
    } catch {
      // Permission and transient filesystem errors mean this candidate is not usable.
    }
  }
  return undefined
}

function uniquePaths(paths: readonly string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>()
  return paths.filter((path) => {
    const key = platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Keep only files that the client-instance launch contract can execute on
 * Windows, preferring native binaries over cmd.exe-compatible npm shims and
 * PowerShell shims. Extensionless POSIX shims must never make an Agent appear
 * installed because Windows CreateProcess cannot launch them directly.
 */
export function orderWindowsLaunchCandidates(
  paths: readonly string[],
  platform: NodeJS.Platform,
): string[] {
  const unique = uniquePaths(paths, platform)
  if (platform !== 'win32') return unique
  const groups = new Map<string, { firstIndex: number; paths: string[] }>()
  unique.forEach((path, index) => {
    if (!isWindowsLaunchCandidate(path)) return
    const base = path.replace(/\.(?:exe|com|cmd|bat|ps1)$/i, '').toLowerCase()
    const group = groups.get(base)
    if (group) group.paths.push(path)
    else groups.set(base, { firstIndex: index, paths: [path] })
  })
  // `where.exe` already expresses PATH precedence. Reordering every .exe
  // ahead of every .cmd can accidentally select an inaccessible packaged-app
  // binary over a working npm shim earlier on PATH (notably Codex on Windows).
  // Only rank launchable siblings that represent the same PATH entry.
  return [...groups.values()]
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .flatMap((group) => group.paths.sort((left, right) => windowsLaunchRank(left) - windowsLaunchRank(right)))
}

function isWindowsLaunchCandidate(path: string): boolean {
  return /\.(?:exe|com|cmd|bat|ps1)$/i.test(path)
}

function windowsLaunchRank(path: string): number {
  const lower = path.toLowerCase()
  if (lower.endsWith('.exe')) return 0
  if (lower.endsWith('.com')) return 1
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) return 2
  return 3
}

async function isExistingFile(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path)
    return metadata.isFile() || metadata.isSymbolicLink()
  } catch {
    return false
  }
}

async function directoryNames(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

async function findCommandOnPath(name: string, platform: NodeJS.Platform): Promise<string[]> {
  const result = platform === 'win32'
    ? await executeCommand('where.exe', [name])
    : await executeCommand('which', ['-a', name])
  return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
}

function executeCommand(file: string, args: string[]): Promise<PlatformCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 3_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || stdout || error.message).trim()))
          return
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) })
      })
  })
}
