import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ClientInstanceManager,
  type ClientInstanceProcess,
} from '../../src/main/client-instances'

class MemoryMetadata {
  private readonly values = new Map<string, string>()

  readAppMetadata(key: string): string | undefined {
    return this.values.get(key)
  }

  async writeAppMetadata(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }
}

describe('Windows terminal process-tree lifecycle', () => {
  it.each([
    ['Grok Build terminal', 'grokbuild', 'terminal'],
    ['Codex background', 'codex', 'background'],
    ['Claude Code background', 'claude', 'background'],
    ['Gemini CLI background', 'gemini', 'background'],
  ] as const)('terminates the complete Windows tree before signaling the %s wrapper', async (
    name,
    client,
    launchMode,
  ) => {
    const root = await mkdtemp(join(tmpdir(), 'stone-windows-terminal-tree-'))
    try {
      const executable = join(root, `${client}.exe`)
      const configDirectory = join(root, `${client}-home`)
      await writeFile(executable, '')
      await mkdir(configDirectory)

      const wrapper = new EventEmitter() as ClientInstanceProcess & EventEmitter
      wrapper.pid = 8_080
      let descendantAlive = true
      const killWrapper = vi.fn(() => {
        // This is how the Windows `cmd /c start ... /wait` supervisor can
        // behave: terminating cmd completes the tracked ChildProcess while the
        // newly created console process remains alive.
        queueMicrotask(() => wrapper.emit('exit', 0, null))
        return true
      })
      wrapper.kill = killWrapper
      const terminateTree = vi.fn(async () => {
        descendantAlive = false
        queueMicrotask(() => wrapper.emit('exit', null, 'SIGKILL'))
      })
      const manager = new ClientInstanceManager({
        store: new MemoryMetadata(),
        platform: 'win32',
        inspectProcess: async () => undefined,
        processAdapter: {
          spawn: () => wrapper,
          terminateTree,
        },
      })
      manager.initialize()
      const [instance] = await manager.save({
        name,
        client,
        configDirectory,
        executablePath: executable,
        launchMode,
      })
      await manager.start(instance.id)

      await manager.stop(instance.id)

      expect(terminateTree).toHaveBeenCalledOnce()
      expect(killWrapper).not.toHaveBeenCalled()
      expect(descendantAlive).toBe(false)
      expect(manager.list()[0]).toMatchObject({ status: 'stopped', processAlive: false })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
