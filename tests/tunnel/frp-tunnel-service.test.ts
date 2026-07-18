import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
    expect(state.config).toContain('secret-control-token')
    expect(state.binaryAvailable).toBe(false)
    expect(state.remoteAddress).toBe('http://frps.example.com:15721/v1')
    expect(await readFile(join(directory, 'frp', 'frpc.toml'), 'utf8')).toBe(content)
  })
})
