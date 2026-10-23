import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeAgentInstallerProcessPort } from '../../src/main/agent-installation/agent-installation-service'
import { discoverAgentExecutable } from '../../src/main/agent-lifecycle/platform-discovery'

describe('native CLI environment smoke', () => {
  const directories: string[] = []
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('passes the resolved PATH to a real subprocess without mutating the parent', async () => {
    const before = process.env.PATH
    const marker = 'stone-cli-smoke-only'
    const port = new NativeAgentInstallerProcessPort(process.platform, { ...process.env }, async (env) => ({ ...env, PATH: marker }))
    const result = await port.execute(process.execPath, ['-e', 'process.stdout.write(process.env.PATH)'], { timeoutMs: 3_000 })
    expect(result.stdout).toBe(marker)
    expect(process.env.PATH).toBe(before)
  })

  it('discovers a real CLI shim using the supplied PATH, not the parent PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-discovery-env-'))
    directories.push(root)
    const executable = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex')
    await writeFile(executable, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const found = await discoverAgentExecutable('codex-cli', {
      environment: { ...process.env, PATH: root }, resolveEnvironment: async (env) => env,
    })
    expect(found).toMatchObject({ installed: true, executablePath: executable, source: 'command-path' })
  })
})
