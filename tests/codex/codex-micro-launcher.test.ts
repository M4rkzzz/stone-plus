import { EventEmitter } from 'node:events'
import type { ChildProcess, spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import {
  codexMicroNoDeviceBootstrap,
  WindowsCodexMicroDisabledLauncher,
} from '../../src/main/codex/codex-micro-launcher'

const TEST_STARTUP_NONCE = 'n'.repeat(43)

describe('WindowsCodexMicroDisabledLauncher', () => {
  it('installs the no-device module before resuming Codex', async () => {
    const child = fakeChild(8123)
    const socket = new FakeInspectorSocket({ identity: { pid: 8123, nonce: TEST_STARTUP_NONCE } })
    const terminateProcess = vi.fn(async () => undefined)
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.emit('spawn')
        child.stderr.write('Debugger listening on ws://127.0.0.1:43123/0d1c7300-2f48-4d1d-91e8-7cc5d1d5dbe7\n')
      })
      return child as ChildProcess
    }) as unknown as typeof spawn
    const createSocket = vi.fn(() => socket as unknown as WebSocket)
    const launcher = new WindowsCodexMicroDisabledLauncher({
      spawnProcess,
      createSocket,
      terminateProcess,
      timeoutMs: 1_000,
      randomNonce: () => TEST_STARTUP_NONCE,
    })

    await launcher.launch('C:\\Codex\\ChatGPT.exe')

    expect(spawnProcess).toHaveBeenCalledWith(
      'C:\\Codex\\ChatGPT.exe',
      ['--inspect-brk=127.0.0.1:0', '--inspect-publish-uid=stderr'],
      expect.objectContaining({
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: expect.objectContaining({ STONE_CODEX_MICRO_STARTUP_NONCE: TEST_STARTUP_NONCE }),
      }),
    )
    expect(createSocket).toHaveBeenCalledWith('ws://127.0.0.1:43123/0d1c7300-2f48-4d1d-91e8-7cc5d1d5dbe7')
    expect(socket.sent.map((message) => message.method)).toEqual([
      'Runtime.enable',
      'Debugger.enable',
      'Runtime.runIfWaitingForDebugger',
      'Debugger.evaluateOnCallFrame',
      'Debugger.evaluateOnCallFrame',
      'Debugger.resume',
      'Runtime.evaluate',
    ])
    expect(socket.sent[3]?.params?.expression).toContain('STONE_CODEX_MICRO_STARTUP_NONCE')
    expect(socket.sent[4]?.params?.expression).toContain('@worklouder/device-kit-oai')
    expect(child.unref).toHaveBeenCalledOnce()
    expect(terminateProcess).not.toHaveBeenCalled()
  })

  it('terminates a startup-paused process when injection fails', async () => {
    const child = fakeChild(9123)
    const socket = new FakeInspectorSocket({
      identity: { pid: 9123, nonce: TEST_STARTUP_NONCE },
      evaluationError: 'bootstrap changed',
    })
    const terminateProcess = vi.fn(async () => undefined)
    const launcher = new WindowsCodexMicroDisabledLauncher({
      spawnProcess: vi.fn(() => {
        queueMicrotask(() => {
          child.emit('spawn')
          child.stderr.write('Debugger listening on ws://127.0.0.1:43124/8a84bf6e-510a-42d1-b576-e3f0cfb747e9\n')
        })
        return child as ChildProcess
      }) as unknown as typeof spawn,
      createSocket: () => socket as unknown as WebSocket,
      terminateProcess,
      timeoutMs: 1_000,
      randomNonce: () => TEST_STARTUP_NONCE,
    })

    await expect(launcher.launch('C:\\Codex\\ChatGPT.exe')).rejects.toThrow('bootstrap changed')

    expect(terminateProcess).toHaveBeenCalledWith(9123)
    expect(child.unref).not.toHaveBeenCalled()
  })

  it('rejects an inspector announcement that is not an exact loopback capability URL', async () => {
    const child = fakeChild(9124)
    const terminateProcess = vi.fn(async () => undefined)
    const createSocket = vi.fn()
    const launcher = new WindowsCodexMicroDisabledLauncher({
      spawnProcess: vi.fn(() => {
        queueMicrotask(() => {
          child.emit('spawn')
          child.stderr.write('Debugger listening on ws://192.0.2.10:43124/8a84bf6e-510a-42d1-b576-e3f0cfb747e9\n')
        })
        return child as ChildProcess
      }) as unknown as typeof spawn,
      createSocket: createSocket as never,
      terminateProcess,
      timeoutMs: 1_000,
      randomNonce: () => TEST_STARTUP_NONCE,
    })

    await expect(launcher.launch('C:\\Codex\\ChatGPT.exe')).rejects.toThrow(/loopback|inspector URL/i)
    expect(createSocket).not.toHaveBeenCalled()
    expect(terminateProcess).toHaveBeenCalledWith(9124)
  })

  it('rejects a debugger target whose PID or startup nonce does not match the spawned process', async () => {
    const child = fakeChild(9125)
    const socket = new FakeInspectorSocket({ identity: { pid: 9999, nonce: 'foreign-nonce' } })
    const terminateProcess = vi.fn(async () => undefined)
    const launcher = new WindowsCodexMicroDisabledLauncher({
      spawnProcess: vi.fn(() => {
        queueMicrotask(() => {
          child.emit('spawn')
          child.stderr.write('Debugger listening on ws://127.0.0.1:43125/900eafc5-83dd-43e4-a4ee-cf01098da494\n')
        })
        return child as ChildProcess
      }) as unknown as typeof spawn,
      createSocket: () => socket as unknown as WebSocket,
      terminateProcess,
      timeoutMs: 1_000,
      randomNonce: () => TEST_STARTUP_NONCE,
    })

    await expect(launcher.launch('C:\\Codex\\ChatGPT.exe')).rejects.toThrow(/identity/i)
    expect(socket.sent.map((message) => message.id)).toEqual([1, 2, 3, 4])
    expect(terminateProcess).toHaveBeenCalledWith(9125)
    expect(child.unref).not.toHaveBeenCalled()
  })

  it('keeps inspector arguments out of Codex task workers', () => {
    expect(() => new Function(codexMicroNoDeviceBootstrap)).not.toThrow()
    expect(codexMicroNoDeviceBootstrap).toContain('process.execArgv.splice')
    expect(codexMicroNoDeviceBootstrap).toContain('execArgv: options.execArgv ?? []')
    expect(codexMicroNoDeviceBootstrap).not.toContain('inspector").close()')
  })

  it('replaces the complete lazy Codex Micro service before it can load native HID discovery', async () => {
    const originalLoad = vi.fn((_request: string) => ({ original: true }))
    const moduleApi = { _load: originalLoad }
    class Worker {}
    const workerThreads = { Worker }
    const processApi = {
      argv: ['ChatGPT.exe', '--inspect-brk=127.0.0.1:9229', '--inspect-publish-uid=stderr'],
      execArgv: ['--inspect-brk=127.0.0.1:9229', '--inspect-publish-uid=stderr'],
      getBuiltinModule: (name: string) => name === 'module' ? moduleApi : workerThreads,
    }

    const result = runInNewContext(codexMicroNoDeviceBootstrap, { process: processApi })
    const currentBundle = moduleApi._load('./codex-micro-service-CY8ASf0t.js') as {
      CodexMicroService: new () => {
        getState(): unknown
        start(): void
        stop(): Promise<void>
        updateLighting(): Promise<boolean>
        dispose(): Promise<void>
      }
    }
    const futureBundle = moduleApi._load('C:\\Codex\\codex-micro-service.js') as typeof currentBundle
    const service = new currentBundle.CodexMicroService()

    service.start()
    expect(result).toBe('stone-codex-micro-disabled')
    expect(service.getState()).toEqual({
      status: 'not-detected',
      transport: null,
      model: null,
      error: null,
      battery: null,
    })
    await expect(service.updateLighting()).resolves.toBe(false)
    await expect(service.stop()).resolves.toBeUndefined()
    await expect(service.dispose()).resolves.toBeUndefined()
    expect(futureBundle.CodexMicroService).toBe(currentBundle.CodexMicroService)
    expect(originalLoad).not.toHaveBeenCalled()
    expect(processApi.execArgv).toEqual([])
    expect(processApi.argv).toEqual(['ChatGPT.exe'])
  })
})

class FakeInspectorSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING
  sent: InspectorCommand[] = []
  private readonly evaluationError?: string
  private readonly identity: { pid: number; nonce: string }

  constructor(options: { identity?: { pid: number; nonce: string }; evaluationError?: string } = {}) {
    super()
    this.evaluationError = options.evaluationError
    this.identity = options.identity ?? { pid: 0, nonce: '' }
    setTimeout(() => {
      this.readyState = WebSocket.OPEN
      this.emit('open')
    }, 0)
  }

  send(serialized: string): void {
    const message = JSON.parse(serialized) as InspectorCommand
    this.sent.push(message)
    if (message.id === 1 || message.id === 2) queueMicrotask(() => this.emit('message', JSON.stringify({ id: message.id, result: {} })))
    if (message.id === 3) queueMicrotask(() => this.emit('message', JSON.stringify({
      method: 'Debugger.paused',
      params: { callFrames: [{ callFrameId: 'frame-1' }] },
    })))
    if (message.id === 4) queueMicrotask(() => this.emit('message', JSON.stringify({
      id: 4,
      result: { result: { value: this.identity } },
    })))
    if (message.id === 5) queueMicrotask(() => this.emit('message', JSON.stringify({
      id: 5,
      result: this.evaluationError
        ? { exceptionDetails: { text: this.evaluationError } }
        : { result: { value: 'stone-codex-micro-disabled' } },
    })))
    if (message.id === 6) queueMicrotask(() => this.emit('message', JSON.stringify({ id: 6, result: {} })))
    if (message.id === 7) queueMicrotask(() => this.emit('message', JSON.stringify({
      id: 7,
      result: { result: { value: 'stone-codex-micro-inspector-closing' } },
    })))
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
  }
}

interface InspectorCommand {
  id?: number
  method?: string
  params?: {
    expression?: string
  }
}

function fakeChild(pid: number): EventEmitter & {
  pid: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stderr: PassThrough
  unref: ReturnType<typeof vi.fn>
} {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    stderr: new PassThrough(),
    unref: vi.fn(),
  })
}
