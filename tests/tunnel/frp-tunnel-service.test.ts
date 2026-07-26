import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrpTunnelService, parseTunnelEndpoint } from '../../src/main/tunnel'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('FRP tunnel service', () => {
  it('derives the published Stone API endpoint from a TCP proxy', () => {
    expect(parseTunnelEndpoint(`
      serverAddr = "frps.example.com"
      serverPort = 7000

      [[proxies]]
      name = "stone"
      type = "tcp"
      localIP = "127.0.0.1"
      localPort = 15721
      remotePort = 25000
    `, true)).toEqual({
      serverAddress: 'frps.example.com',
      remotePort: 25000,
      remoteAddress: 'http://frps.example.com:25000/v1'
    })
  })

  it('formats an IPv6 frps address for use in a URL', () => {
    expect(parseTunnelEndpoint(`
      serverAddr = "2001:db8::1"
      [[proxies]]
      name = "stone"
      type = "tcp"
      remotePort = 15721
    `, true).remoteAddress).toBe('http://[2001:db8::1]:15721/v1')
  })

  it('rejects configurations without a published TCP port', () => {
    expect(() => parseTunnelEndpoint('serverAddr = "frps.example.com"', true)).toThrow(/TCP proxy/)
  })

  it('persists configuration without exposing it through Stone diagnostics', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-frp-test-'))
    temporaryDirectories.push(directory)
    const service = new FrpTunnelService({
      userDataPath: directory,
      binaryPath: join(directory, 'missing-frpc.exe'),
      binaryExists: async () => false
    })
    await service.initialize()
    const content = `serverAddr = "frps.example.com"
auth.token = "secret-control-token"
[[proxies]]
name = "stone"
type = "tcp"
remotePort = 15721
`
    const state = await service.saveConfig(content)
    expect(state.config).not.toContain('secret-control-token')
    expect(state.config).toContain('[REDACTED]')
    expect(state.binaryAvailable).toBe(false)
    expect(state.remoteAddress).toBe('http://frps.example.com:15721/v1')
    expect(await readFile(join(directory, 'frp', 'frpc.toml'), 'utf8')).toBe(content)
  })

  it('redacts auth and OIDC secrets without overwriting them when the masked config is saved', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-frp-secret-'))
    temporaryDirectories.push(directory)
    const service = new FrpTunnelService({ userDataPath: directory, binaryPath: join(directory, 'frpc'), platform: 'linux' })
    await service.initialize()
    await service.saveConfig(`serverAddr = "example.com"\nauth.token = "control-secret#suffix" # private\n[auth.oidc]\nclientSecret = "oidc-secret"\n[[proxies]]\ntype = "tcp"\nremotePort = 15721\n`)
    const masked = (await service.getState()).config
    expect(masked).not.toContain('control-secret')
    expect(masked).not.toContain('suffix')
    expect(masked).not.toContain('oidc-secret')
    await service.saveConfig(masked)
    const persisted = await readFile(join(directory, 'frp', 'frpc.toml'), 'utf8')
    expect(persisted).toContain('control-secret#suffix')
    expect(persisted).toContain('oidc-secret')
    if (process.platform !== 'win32') {
      expect((await stat(join(directory, 'frp'))).mode & 0o777).toBe(0o700)
      expect((await stat(join(directory, 'frp', 'frpc.toml'))).mode & 0o777).toBe(0o600)
    }
  })

  it('recursively redacts inline tables, array tables, mixed-case keys, and restores every placeholder structurally', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-frp-structured-secret-'))
    temporaryDirectories.push(directory)
    const service = new FrpTunnelService({ userDataPath: directory, binaryPath: join(directory, 'frpc'), platform: 'linux' })
    await service.initialize()
    const original = `serverAddr = "example.com"
auth = { ToKeN = "inline-token", oidc = { ClientSECRET = "inline-client-secret" } }
displayName = "[REDACTED]"
[[proxies]]
name = "stone"
type = "tcp"
remotePort = 15721
secretKey = "array-secret"
PassWord = "array-password"
credentialFile = "credential-value"
AUTHORIZATIONHeader = "Bearer authorization-value"
`
    await service.saveConfig(original)

    const masked = (await service.getState()).config
    for (const secret of [
      'inline-token', 'inline-client-secret', 'array-secret', 'array-password',
      'credential-value', 'authorization-value',
    ]) expect(masked).not.toContain(secret)
    expect(masked).toContain('displayName = "[REDACTED]"')

    await service.saveConfig(masked)
    const restored = parse(await readFile(join(directory, 'frp', 'frpc.toml'), 'utf8')) as Record<string, unknown>
    expect(restored).toMatchObject({
      auth: { ToKeN: 'inline-token', oidc: { ClientSECRET: 'inline-client-secret' } },
      displayName: '[REDACTED]',
      proxies: [{
        secretKey: 'array-secret',
        PassWord: 'array-password',
        credentialFile: 'credential-value',
        AUTHORIZATIONHeader: 'Bearer authorization-value',
      }],
    })
  })

  it('fails closed when a masked secret has no corresponding persisted value', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-frp-orphan-mask-'))
    temporaryDirectories.push(directory)
    const service = new FrpTunnelService({ userDataPath: directory, binaryPath: join(directory, 'frpc'), platform: 'linux' })
    await service.initialize()
    await service.saveConfig('serverAddr = "example.com"\n[[proxies]]\ntype = "tcp"\nremotePort = 15721\n')

    await expect(service.saveConfig(
      'serverAddr = "example.com"\nauth.token = "[REDACTED]"\n[[proxies]]\ntype = "tcp"\nremotePort = 15721\n',
    )).rejects.toThrow(/stored secret|redacted/i)
  })

  it('requires a binary integrity verifier before configuration validation or spawn and redacts verifier errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-frp-integrity-'))
    temporaryDirectories.push(directory)
    const binaryPath = join(directory, 'frpc.exe')
    await writeFile(binaryPath, 'not-a-real-binary')
    const verifyBinaryIntegrity = vi.fn(async () => {
      throw new Error('clientSecret = "verifier-secret" password: verifier-password Authorization: Basic verifier-token {"apiToken":"json-token"}')
    })
    const service = new FrpTunnelService({
      userDataPath: directory,
      binaryPath,
      binaryExists: async () => true,
      verifyBinaryIntegrity,
    })
    await service.initialize()
    await service.saveConfig('serverAddr = "example.com"\n[[proxies]]\ntype = "tcp"\nremotePort = 15721\n')

    await expect(service.start()).rejects.toThrow(/integrity/i)
    expect(verifyBinaryIntegrity).toHaveBeenCalledWith(binaryPath)
    const serializedState = JSON.stringify(await service.getState())
    expect(serializedState).not.toContain('verifier-secret')
    expect(serializedState).not.toContain('verifier-password')
    expect(serializedState).not.toContain('verifier-token')
    expect(serializedState).not.toContain('json-token')
    expect(serializedState).toContain('[REDACTED]')
  })

  it('adopts a verified frpc process marker after Stone+ restarts and terminates its tree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-frp-recovery-'))
    temporaryDirectories.push(directory)
    const binaryPath = join(directory, 'frpc.exe')
    const configPath = join(directory, 'frp', 'frpc.toml')
    await mkdir(join(directory, 'frp'), { recursive: true })
    await writeFile(binaryPath, '')
    await writeFile(configPath, 'serverAddr = "example.com"\n[[proxies]]\ntype = "tcp"\nremotePort = 15721\n')
    await writeFile(join(directory, 'frp', 'frpc-process.json'), JSON.stringify({
      version: 1, pid: 4242, executablePath: await realpath(binaryPath), configPath, startedAt: 123,
    }))
    const terminated: number[] = []
    const verifyBinaryIntegrity = vi.fn(async () => undefined)
    const service = new FrpTunnelService({
      userDataPath: directory,
      binaryPath,
      platform: 'win32',
      verifyBinaryIntegrity,
      inspectProcess: async () => ({ executablePath: await realpath(binaryPath), commandLine: `"${binaryPath}" -c "${configPath}"` }),
      terminateProcessTree: async (pid) => { terminated.push(pid) },
    })

    await service.initialize()
    const recovered = await service.getState()
    expect(recovered.lastError).toBeUndefined()
    expect(recovered).toMatchObject({ running: true, pid: 4242, startedAt: 123 })
    expect(verifyBinaryIntegrity).toHaveBeenCalledWith(await realpath(binaryPath))
    await service.stop()
    expect(terminated).toEqual([4242])
    await expect(readFile(join(directory, 'frp', 'frpc-process.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discards a recovery marker when the marked frpc binary fails integrity without touching the process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-frp-recovery-integrity-'))
    temporaryDirectories.push(directory)
    const binaryPath = join(directory, 'frpc.exe')
    const configPath = join(directory, 'frp', 'frpc.toml')
    const markerPath = join(directory, 'frp', 'frpc-process.json')
    await mkdir(join(directory, 'frp'), { recursive: true })
    await writeFile(binaryPath, 'tampered')
    await writeFile(configPath, 'serverAddr = "example.com"\n[[proxies]]\ntype = "tcp"\nremotePort = 15721\n')
    await writeFile(markerPath, JSON.stringify({
      version: 1, pid: 4343, executablePath: await realpath(binaryPath), configPath, startedAt: 456,
    }))
    const inspectProcess = vi.fn(async () => ({
      executablePath: await realpath(binaryPath),
      commandLine: `"${binaryPath}" -c "${configPath}"`,
    }))
    const terminateProcessTree = vi.fn(async () => undefined)
    const verifyBinaryIntegrity = vi.fn(async () => {
      throw new Error('checksum mismatch')
    })
    const service = new FrpTunnelService({
      userDataPath: directory,
      binaryPath,
      platform: 'win32',
      verifyBinaryIntegrity,
      inspectProcess,
      terminateProcessTree,
    })

    await service.initialize()

    expect(await service.getState()).toMatchObject({ running: false })
    expect((await service.getState()).lastError).toMatch(/integrity/i)
    expect(verifyBinaryIntegrity).toHaveBeenCalledWith(await realpath(binaryPath))
    expect(inspectProcess).not.toHaveBeenCalled()
    await service.stop()
    expect(terminateProcessTree).not.toHaveBeenCalled()
    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a stale or PID-reused marker instead of adopting an unrelated process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-frp-stale-'))
    temporaryDirectories.push(directory)
    const binaryPath = join(directory, 'frpc.exe')
    const configPath = join(directory, 'frp', 'frpc.toml')
    await mkdir(join(directory, 'frp'), { recursive: true })
    await writeFile(binaryPath, '')
    await writeFile(join(directory, 'frp', 'frpc-process.json'), JSON.stringify({
      version: 1, pid: 4242, executablePath: binaryPath, configPath, startedAt: 123,
    }))
    const service = new FrpTunnelService({
      userDataPath: directory,
      binaryPath,
      platform: 'win32',
      verifyBinaryIntegrity: async () => undefined,
      inspectProcess: async () => ({ executablePath: 'C:\\Windows\\System32\\notepad.exe', commandLine: 'notepad.exe' }),
    })

    await service.initialize()
    expect(await service.getState()).toMatchObject({ running: false })
    await expect(readFile(join(directory, 'frp', 'frpc-process.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
