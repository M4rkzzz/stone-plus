import { EventEmitter } from 'node:events'
import type { ChildProcess, spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import {
  codexMicroNoDeviceBootstrap,
  WindowsCodexMicroDisabledLauncher,
} from '../../src/main/codex/codex-micro-launcher'

describe('WindowsCodexMicroDisabledLauncher', () => {
  it('installs the no-device module before resuming Codex', async () => {
    const child = fakeChild(8123)
    const socket = new FakeInspectorSocket()
    const terminateProcess = vi.fn(async () => undefined)
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child as ChildProcess
    }) as unknown as typeof spawn
    const launcher = new WindowsCodexMicroDisabledLauncher({
      spawnProcess,
      fetchImplementation: vi.fn(async () => new Response(JSON.stringify([{
        webSocketDebuggerUrl: 'ws://127.0.0.1/inspector',
      }]), { status: 200 })),
      createSocket: () => socket as unknown as WebSocket,
      terminateProcess,
      timeoutMs: 1_000,
    })

    await launcher.launch('C:\\Codex\\ChatGPT.exe')

    expect(spawnProcess).toHaveBeenCalledWith(
      'C:\\Codex\\ChatGPT.exe',
      [expect.stringMatching(/^--inspect-brk=127\.0\.0\.1:\d+$/)],
      expect.objectContaining({ detached: true }),
    )
    expect(socket.sent.map((message) => message.method)).toEqual([
      'Runtime.enable',
      'Debugger.enable',
      'Runtime.runIfWaitingForDebugger',
      'Debugger.evaluateOnCallFrame',
      'Debugger.resume',
      'Runtime.evaluate',
    ])
    expect(socket.sent[3]?.params?.expression).toContain('@worklouder/device-kit-oai')
    expect(child.unref).toHaveBeenCalledOnce()
    expect(terminateProcess).not.toHaveBeenCalled()
  })

  it('terminates a startup-paused process when injection fails', async () => {
    const child = fakeChild(9123)
    const socket = new FakeInspectorSocket({ evaluationError: 'bootstrap changed' })
    const terminateProcess = vi.fn(async () => undefined)
    const launcher = new WindowsCodexMicroDisabledLauncher({
      spawnProcess: vi.fn(() => {
        queueMicrotask(() => child.emit('spawn'))
        return child as ChildProcess
      }) as unknown as typeof spawn,
      fetchImplementation: vi.fn(async () => new Response(JSON.stringify([{
        webSocketDebuggerUrl: 'ws://127.0.0.1/inspector',
      }]), { status: 200 })),
      createSocket: () => socket as unknown as WebSocket,
      terminateProcess,
      timeoutMs: 1_000,
    })

    await expect(launcher.launch('C:\\Codex\\ChatGPT.exe')).rejects.toThrow('bootstrap changed')

    expect(terminateProcess).toHaveBeenCalledWith(9123)
    expect(child.unref).not.toHaveBeenCalled()
  })

  it('keeps inspector arguments out of Codex task workers', () => {
    expect(() => new Function(codexMicroNoDeviceBootstrap)).not.toThrow()
    expect(codexMicroNoDeviceBootstrap).toContain('process.execArgv.splice')
    expect(codexMicroNoDeviceBootstrap).toContain('execArgv: options.execArgv ?? []')
    expect(codexMicroNoDeviceBootstrap).not.toContain('inspector").close()')
  })
})

class FakeInspectorSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING
  sent: InspectorCommand[] = []
  private readonly evaluationError?: string

  constructor(options: { evaluationError?: string } = {}) {
    super()
    this.evaluationError = options.evaluationError
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
      result: this.evaluationError
        ? { exceptionDetails: { text: this.evaluationError } }
        : { result: { value: 'stone-codex-micro-disabled' } },
    })))
    if (message.id === 5 || message.id === 6) queueMicrotask(() => this.emit('message', JSON.stringify({
      id: message.id,
      result: {},
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

function fakeChild(pid: number): EventEmitter & { pid: number; exitCode: number | null; unref: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    unref: vi.fn(),
  })
}
