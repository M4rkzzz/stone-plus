import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'

interface CodexMicroLauncherOptions {
  spawnProcess?: typeof spawn
  fetchImplementation?: typeof fetch
  createSocket?: (url: string) => WebSocket
  terminateProcess?: (pid: number) => Promise<void>
  timeoutMs?: number
}

/**
 * Starts the Windows Codex desktop process with its optional Work Louder module
 * replaced by a no-device implementation. The startup inspector is bound to
 * loopback, used once, and closed by the injected bootstrap before the app runs.
 */
export class WindowsCodexMicroDisabledLauncher {
  private readonly spawnProcess: typeof spawn
  private readonly fetchImplementation: typeof fetch
  private readonly createSocket: (url: string) => WebSocket
  private readonly terminateProcess: (pid: number) => Promise<void>
  private readonly timeoutMs: number

  constructor(options: CodexMicroLauncherOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawn
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url))
    this.terminateProcess = options.terminateProcess ?? terminateWindowsProcessTree
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  async launch(executablePath: string): Promise<void> {
    const port = await reserveLoopbackPort()
    const child = await this.spawnPaused(executablePath, port)
    try {
      const inspectorUrl = await this.waitForInspector(port, child)
      await installNoDeviceStub(inspectorUrl, this.createSocket, Math.min(this.timeoutMs, 10_000))
      child.unref()
    } catch (cause) {
      if (child.pid) await this.terminateProcess(child.pid).catch(() => undefined)
      throw cause
    }
  }

  private spawnPaused(executablePath: string, port: number): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(
        executablePath,
        [`--inspect-brk=127.0.0.1:${port}`],
        { detached: true, stdio: 'ignore', windowsHide: false },
      )
      child.once('error', reject)
      child.once('spawn', () => resolve(child))
    })
  }

  private async waitForInspector(port: number, child: ChildProcess): Promise<string> {
    const deadline = Date.now() + this.timeoutMs
    let lastError = 'inspector did not respond'
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Codex exited during Micro disable startup (exit ${child.exitCode}).`)
      try {
        const response = await this.fetchImplementation(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(750),
        })
        if (response.ok) {
          const targets = await response.json() as Array<{ webSocketDebuggerUrl?: string }>
          const url = targets.find((target) => target.webSocketDebuggerUrl)?.webSocketDebuggerUrl
          if (url) return url
        } else {
          lastError = `inspector returned HTTP ${response.status}`
        }
      } catch (cause) {
        lastError = messageOf(cause)
      }
      await delay(100)
    }
    throw new Error(`Codex Micro startup hook timed out: ${lastError}`)
  }
}

export const codexMicroNoDeviceBootstrap = String.raw`
(() => {
  const Module = process.getBuiltinModule("module");
  const isInspectorArgument = (value) => typeof value === "string" && /^--inspect(?:-brk)?(?:=|$)/.test(value);
  process.execArgv.splice(0, process.execArgv.length, ...process.execArgv.filter((value) => !isInspectorArgument(value)));
  process.argv.splice(0, process.argv.length, ...process.argv.filter((value) => !isInspectorArgument(value)));
  const workerThreads = process.getBuiltinModule("worker_threads");
  const NativeWorker = workerThreads.Worker;
  if (!NativeWorker.__stoneCodexMicroWorker) {
    class StoneCodexWorker extends NativeWorker {
      constructor(filename, options = {}) { super(filename, { ...options, execArgv: options.execArgv ?? [] }); }
    }
    Object.defineProperty(StoneCodexWorker, "__stoneCodexMicroWorker", { value: true });
    workerThreads.Worker = StoneCodexWorker;
  }
  const noDeviceModule = {
    ConnectionEventType: { CONNECTED: "CONNECTED", DISCONNECTED: "DISCONNECTED", ERROR: "ERROR" },
    DeviceType: { Project2077: "Project2077" },
    OAILightingEffect: { off: 0, breath: 1, solid: 2, snake: 3 },
    WLDeviceDiscovery: class { findWLDevices() { return []; } },
    WLDeviceCommImpl: class {
      onConnectionEvent() { return () => {}; }
      async connect() {}
      async disconnect() {}
    },
    RPCApiOAI: class {
      onHidReceived() { return () => {}; }
      onJoystickMove() { return () => {}; }
      async sendLightingConfig() { return true; }
      async sendThreadsLighting() { return true; }
      async getDeviceStatus() { return {}; }
    },
  };
  const originalLoad = Module._load;
  Module._load = function stoneCodexMicroLoader(request) {
    if (request === "@worklouder/device-kit-oai") return noDeviceModule;
    return Reflect.apply(originalLoad, this, arguments);
  };
  globalThis.__STONE_CODEX_MICRO_DISABLED__ = true;
  return "stone-codex-micro-disabled";
})()
`

const closeInspectorBootstrap = String.raw`
(() => {
  setImmediate(() => { try { process.getBuiltinModule("inspector").close(); } catch {} });
  return "stone-codex-micro-inspector-closing";
})()
`

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not reserve a loopback inspector port.')
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function installNoDeviceStub(
  url: string,
  createSocket: (url: string) => WebSocket,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(url)
    let runtimeReady = false
    let debuggerReady = false
    let continued = false
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('Codex Micro startup hook WebSocket timed out.')), timeoutMs)
    socket.once('error', () => finish(new Error('Codex Micro startup hook WebSocket failed.')))
    socket.once('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }))
      socket.send(JSON.stringify({ id: 2, method: 'Debugger.enable' }))
    })
    socket.on('message', (raw) => {
      if (settled) return
      let message: InspectorMessage
      try {
        message = JSON.parse(String(raw)) as InspectorMessage
      } catch {
        finish(new Error('Codex Micro startup hook returned invalid inspector data.'))
        return
      }
      if (message.id === 1) runtimeReady = true
      if (message.id === 2) debuggerReady = true
      if (runtimeReady && debuggerReady && !continued) {
        continued = true
        socket.send(JSON.stringify({ id: 3, method: 'Runtime.runIfWaitingForDebugger' }))
      }
      if (message.method === 'Debugger.paused') {
        const callFrameId = message.params?.callFrames?.[0]?.callFrameId
        if (!callFrameId) {
          finish(new Error('Codex Micro startup hook did not receive a call frame.'))
          return
        }
        socket.send(JSON.stringify({
          id: 4,
          method: 'Debugger.evaluateOnCallFrame',
          params: { callFrameId, expression: codexMicroNoDeviceBootstrap, returnByValue: true, silent: false },
        }))
      }
      if (message.id === 4) {
        if (message.result?.exceptionDetails) {
          finish(new Error(message.result.exceptionDetails.exception?.description
            ?? message.result.exceptionDetails.text
            ?? 'Codex Micro startup hook evaluation failed.'))
          return
        }
        socket.send(JSON.stringify({ id: 5, method: 'Debugger.resume' }))
        return
      }
      if (message.id === 5) {
        if (message.result?.exceptionDetails) {
          finish(new Error('Codex Micro startup hook could not resume Codex.'))
          return
        }
        socket.send(JSON.stringify({
          id: 6,
          method: 'Runtime.evaluate',
          params: { expression: closeInspectorBootstrap, returnByValue: true, silent: true },
        }))
        return
      }
      if (message.id === 6) {
        if (message.result?.exceptionDetails) {
          finish(new Error('Codex Micro startup hook could not close the inspector.'))
          return
        }
        finish()
      }
    })
  })
}

interface InspectorMessage {
  id?: number
  method?: string
  params?: { callFrames?: Array<{ callFrameId?: string }> }
  result?: {
    exceptionDetails?: {
      text?: string
      exception?: { description?: string }
    }
  }
}

function terminateWindowsProcessTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`taskkill exited with code ${code}`)))
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
