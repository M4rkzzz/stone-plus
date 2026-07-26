import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { WebSocket } from 'ws'

interface CodexMicroLauncherOptions {
  spawnProcess?: typeof spawn
  createSocket?: (url: string) => WebSocket
  terminateProcess?: (pid: number) => Promise<void>
  timeoutMs?: number
  randomNonce?: () => string
}

const STARTUP_NONCE_ENV = 'STONE_CODEX_MICRO_STARTUP_NONCE'
const INSPECTOR_ANNOUNCEMENT_LIMIT = 64 * 1024
const INSPECTOR_CAPABILITY_PATH = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Starts the Windows Codex desktop process with its optional Work Louder module
 * replaced by a no-device implementation. Node atomically allocates the
 * loopback inspector port and publishes its unguessable capability URL only to
 * Stone+'s private stderr pipe. The target PID and a one-use startup nonce are
 * verified before any bootstrap is evaluated, then the inspector is closed.
 */
export class WindowsCodexMicroDisabledLauncher {
  private readonly spawnProcess: typeof spawn
  private readonly createSocket: (url: string) => WebSocket
  private readonly terminateProcess: (pid: number) => Promise<void>
  private readonly timeoutMs: number
  private readonly randomNonce: () => string

  constructor(options: CodexMicroLauncherOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawn
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url))
    this.terminateProcess = options.terminateProcess ?? terminateWindowsProcessTree
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.randomNonce = options.randomNonce ?? (() => randomBytes(32).toString('base64url'))
  }

  async launch(executablePath: string): Promise<void> {
    const nonce = this.randomNonce()
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) {
      throw new Error('Codex Micro startup nonce generation failed.')
    }
    const child = this.spawnPaused(executablePath, nonce)
    // ChildProcess emits `error` outside spawn-time failures as well. Keep one
    // listener for the detached lifetime so a late OS error cannot terminate
    // Stone+'s main process after the one-shot startup waiter is removed.
    child.on('error', () => undefined)
    try {
      const inspectorUrl = await waitForPrivateInspectorAnnouncement(child, this.timeoutMs)
      if (!child.pid || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
        throw new Error('Codex Micro startup hook could not verify the spawned process identifier.')
      }
      await installNoDeviceStub(
        inspectorUrl,
        child.pid,
        nonce,
        this.createSocket,
        Math.min(this.timeoutMs, 10_000),
      )
      child.unref()
    } catch (cause) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        await this.terminateProcess(child.pid).catch(() => undefined)
      }
      throw cause
    }
  }

  private spawnPaused(executablePath: string, nonce: string): ChildProcess {
    return this.spawnProcess(
      executablePath,
      ['--inspect-brk=127.0.0.1:0', '--inspect-publish-uid=stderr'],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: false,
        env: { ...process.env, [STARTUP_NONCE_ENV]: nonce },
      },
    )
  }
}

export const codexMicroNoDeviceBootstrap = String.raw`
(() => {
  const Module = process.getBuiltinModule("module");
  const isInspectorArgument = (value) => typeof value === "string" && /^--inspect(?:-brk|-publish-uid)?(?:=|$)/.test(value);
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
  const noDeviceState = Object.freeze({
    status: "not-detected",
    transport: null,
    model: null,
    error: null,
    battery: null,
  });
  class StoneCodexMicroService {
    getState() { return noDeviceState; }
    start() {}
    async stop() {}
    async updateLighting() { return false; }
    dispose() { return this.stop(); }
  }
  const noDeviceServiceModule = { CodexMicroService: StoneCodexMicroService };
  const noDeviceModule = {
    ConnectionEventType: { CONNECTED: "CONNECTED", DISCONNECTED: "DISCONNECTED", ERROR: "ERROR" },
    ConnectionType: { hid: "hid" },
    DeviceLayoutType: { universal: "universal" },
    DeviceType: {
      CodexMicro: "CodexMicro",
      CreatorMicroV2: "CreatorMicroV2",
      Project2077: "Project2077",
    },
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
    if (typeof request === "string" && /(?:^|[\\/])codex-micro-service(?:-[^\\/]+)?\.js$/.test(request)) {
      return noDeviceServiceModule;
    }
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

function waitForPrivateInspectorAnnouncement(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const stderr = child.stderr
    if (!stderr) {
      reject(new Error('Codex Micro startup hook did not receive a private inspector pipe.'))
      return
    }
    let buffer = ''
    let settled = false
    const finish = (error?: Error, inspectorUrl?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stderr.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      // Keep draining the private pipe without keeping the parent event loop
      // alive. Closing it can surface EPIPE inside the launched Electron app.
      stderr.resume()
      ;(stderr as typeof stderr & { unref?: () => void }).unref?.()
      if (error) reject(error)
      else resolve(inspectorUrl!)
    }
    const onError = (error: Error): void => finish(new Error(`Codex Micro startup failed: ${error.message}`))
    const onExit = (code: number | null): void => finish(new Error(
      `Codex exited during Micro disable startup (exit ${code === null ? 'unknown' : code}).`,
    ))
    const onData = (chunk: Buffer | string): void => {
      buffer += String(chunk)
      if (buffer.length > INSPECTOR_ANNOUNCEMENT_LIMIT) {
        finish(new Error('Codex Micro inspector announcement exceeded the safe size limit.'))
        return
      }
      const match = /Debugger listening on\s+(ws:\/\/\S+)/i.exec(buffer)
      if (!match) return
      try {
        finish(undefined, validatePrivateInspectorUrl(match[1]))
      } catch (cause) {
        finish(cause instanceof Error ? cause : new Error(String(cause)))
      }
    }
    const timer = setTimeout(
      () => finish(new Error('Codex Micro startup hook timed out waiting for the private inspector announcement.')),
      timeoutMs,
    )
    child.once('error', onError)
    child.once('exit', onExit)
    stderr.on('data', onData)
  })
}

function validatePrivateInspectorUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Codex Micro returned an invalid inspector URL.')
  }
  const port = Number(url.port)
  if (url.protocol !== 'ws:'
    || url.hostname !== '127.0.0.1'
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
    || url.username
    || url.password
    || url.search
    || url.hash
    || !INSPECTOR_CAPABILITY_PATH.test(url.pathname)) {
    throw new Error('Codex Micro rejected a non-loopback or malformed inspector URL.')
  }
  return url.toString()
}

function installNoDeviceStub(
  url: string,
  expectedPid: number,
  expectedNonce: string,
  createSocket: (url: string) => WebSocket,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(url)
    let runtimeReady = false
    let debuggerReady = false
    let continued = false
    let identityRequested = false
    let settled = false
    let callFrameId: string | undefined
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
    socket.once('close', () => finish(new Error('Codex Micro startup hook WebSocket closed before verification completed.')))
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
      if (message.error) {
        finish(new Error(`Codex Micro inspector command failed: ${message.error.message ?? 'unknown protocol error'}`))
        return
      }
      if (message.id === 1) runtimeReady = true
      if (message.id === 2) debuggerReady = true
      if (runtimeReady && debuggerReady && !continued) {
        continued = true
        socket.send(JSON.stringify({ id: 3, method: 'Runtime.runIfWaitingForDebugger' }))
      }
      if (message.method === 'Debugger.paused') {
        if (identityRequested) return
        callFrameId = message.params?.callFrames?.[0]?.callFrameId
        if (!callFrameId) {
          finish(new Error('Codex Micro startup hook did not receive a call frame.'))
          return
        }
        identityRequested = true
        socket.send(JSON.stringify({
          id: 4,
          method: 'Debugger.evaluateOnCallFrame',
          params: {
            callFrameId,
            expression: inspectorIdentityExpression(),
            returnByValue: true,
            silent: true,
          },
        }))
      }
      if (message.id === 4) {
        if (message.result?.exceptionDetails) {
          finish(new Error('Codex Micro startup hook could not verify debugger identity.'))
          return
        }
        const identity = message.result?.result?.value
        if (!isInspectorIdentity(identity)
          || identity.pid !== expectedPid
          || identity.nonce !== expectedNonce
          || !callFrameId) {
          finish(new Error('Codex Micro rejected a debugger target with a mismatched process identity.'))
          return
        }
        socket.send(JSON.stringify({
          id: 5,
          method: 'Debugger.evaluateOnCallFrame',
          params: {
            callFrameId,
            expression: bootstrapWithNonceCleanup(),
            returnByValue: true,
            silent: false,
          },
        }))
        return
      }
      if (message.id === 5) {
        if (message.result?.exceptionDetails) {
          finish(new Error(message.result.exceptionDetails.exception?.description
            ?? message.result.exceptionDetails.text
            ?? 'Codex Micro startup hook evaluation failed.'))
          return
        }
        if (message.result?.result?.value !== 'stone-codex-micro-disabled') {
          finish(new Error('Codex Micro startup hook did not confirm the no-device bootstrap.'))
          return
        }
        socket.send(JSON.stringify({ id: 6, method: 'Debugger.resume' }))
        return
      }
      if (message.id === 6) {
        if (message.result?.exceptionDetails) {
          finish(new Error('Codex Micro startup hook could not resume Codex.'))
          return
        }
        socket.send(JSON.stringify({
          id: 7,
          method: 'Runtime.evaluate',
          params: { expression: closeInspectorBootstrap, returnByValue: true, silent: true },
        }))
        return
      }
      if (message.id === 7) {
        if (message.result?.exceptionDetails) {
          finish(new Error('Codex Micro startup hook could not close the inspector.'))
          return
        }
        if (message.result?.result?.value !== 'stone-codex-micro-inspector-closing') {
          finish(new Error('Codex Micro startup hook did not confirm inspector shutdown.'))
          return
        }
        finish()
      }
    })
  })
}

function inspectorIdentityExpression(): string {
  return `(() => ({ pid: process.pid, nonce: process.env?.[${JSON.stringify(STARTUP_NONCE_ENV)}] }))()`
}

function bootstrapWithNonceCleanup(): string {
  return `(() => { try { delete process.env[${JSON.stringify(STARTUP_NONCE_ENV)}] } catch {} return (${codexMicroNoDeviceBootstrap}) })()`
}

interface InspectorMessage {
  id?: number
  method?: string
  error?: { message?: string }
  params?: { callFrames?: Array<{ callFrameId?: string }> }
  result?: {
    result?: { value?: unknown }
    exceptionDetails?: {
      text?: string
      exception?: { description?: string }
    }
  }
}

function isInspectorIdentity(value: unknown): value is { pid: number; nonce: string } {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { pid?: unknown; nonce?: unknown }
  return typeof candidate.pid === 'number'
    && Number.isSafeInteger(candidate.pid)
    && typeof candidate.nonce === 'string'
}

function terminateWindowsProcessTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`taskkill exited with code ${code}`)))
  })
}
