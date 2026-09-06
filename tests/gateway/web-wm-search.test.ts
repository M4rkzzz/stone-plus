import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer as createNodeServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {} }))

import {
  ChatGptWebWmProtocolRuntime,
  type WebWmLocalTool,
} from '../../src/main/chatgpt-web-wm'
import {
  GatewayServer,
  type ChatGptWebWmTransportRequest,
  type GatewayConfig,
} from '../../src/main/gateway'
import type { Account, GatewaySettings, Pool, ProviderDefinition, RequestLog, Route } from '../../src/shared/types'
import {
  CHATGPT_WEB_WM_PROTOCOL_REVISION,
  GPT_5_6_SOL_MODEL,
  GPT_5_6_SOL_WM_MODEL,
  MINIMUM_CODEX_APP_SERVER_WEB_WM_VERSION,
  codexWebWmClientUpdateRequired,
} from '../../src/shared/wm-routing'

const timestamp = 1_700_000_000_000
const runningServers: GatewayServer[] = []
const runCodexDesktopSmoke = process.env.STONE_RUN_CODEX_DESKTOP_SMOKE === '1'

interface ChildResult {
  code: number
  stdout: string
  stderr: string
}

interface CodexCliLaunch {
  file: string
  argsPrefix: string[]
}

function runChild(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void terminateChildTree(child.pid).finally(() => {
        reject(new Error(`Child process timed out after ${options.timeoutMs}ms: ${file}`))
      })
    }, options.timeoutMs)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

async function terminateChildTree(pid: number | undefined): Promise<void> {
  if (!pid) return
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The process may have exited between the timeout and cleanup.
    }
    return
  }
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.once('error', () => resolve())
    killer.once('close', () => resolve())
  })
}

async function removeSmokeRoot(smokeRoot: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(smokeRoot, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY'
      if (!retryable || attempt === 7) throw error
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}

async function resolveCodexDesktopLaunch(cwd: string, smokeRoot: string): Promise<CodexCliLaunch> {
  const locator = process.platform === 'win32'
    ? await runChild('where.exe', ['codex'], { cwd, env: process.env, timeoutMs: 10_000 })
    : await runChild('which', ['codex'], { cwd, env: process.env, timeoutMs: 10_000 })
  const paths = locator.code === 0
    ? locator.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    : []
  const configuredDesktopBinary = process.env.STONE_CODEX_DESKTOP_BIN?.trim()
  const desktopBinary = configuredDesktopBinary && existsSync(configuredDesktopBinary)
    ? configuredDesktopBinary
    : await newestInstalledCodexDesktopBinary()
      ?? paths.find((value) => (
        value.toLowerCase().endsWith('codex.exe')
        && value.toLowerCase().includes('\\windowsapps\\openai.codex_')
      ))
  if (!desktopBinary) {
    throw new Error(
      `The current Codex Desktop binary was not found. ${locator.stderr}`.trim(),
    )
  }
  const copiedBinary = join(smokeRoot, 'codex-desktop.exe')
  await copyFile(desktopBinary, copiedBinary)
  for (const helper of [
    'codex-code-mode-host.exe',
    'codex-command-runner.exe',
    'codex-windows-sandbox-setup.exe',
  ]) {
    const source = join(dirname(desktopBinary), helper)
    if (existsSync(source)) await copyFile(source, join(smokeRoot, helper))
  }
  const version = await runChild(copiedBinary, ['--version'], {
    cwd,
    env: process.env,
    timeoutMs: 10_000,
  })
  const reportedVersion = /^codex-cli\s+([^\s]+)$/.exec(version.stdout.trim())?.[1]
  if (version.code !== 0 || !reportedVersion
    || codexWebWmClientUpdateRequired(`codex_cli_rs/${reportedVersion}`)) {
    throw new Error([
      `Codex Desktop app-server is older than ${MINIMUM_CODEX_APP_SERVER_WEB_WM_VERSION}.`,
      version.stdout,
      version.stderr,
    ].join('\n'))
  }
  return { file: copiedBinary, argsPrefix: [] }
}

async function newestInstalledCodexDesktopBinary(): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined
  const windowsApps = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'WindowsApps')
  const entries = await readdir(windowsApps, { withFileTypes: true }).catch(() => [])
  return entries.flatMap((entry) => {
    if (!entry.isDirectory()) return []
    const match = /^OpenAI\.Codex_([0-9]+(?:\.[0-9]+){3})_(?:x64|arm64)__/.exec(entry.name)
    return match ? [{ name: entry.name, version: match[1].split('.').map(Number) }] : []
  }).sort((left, right) => compareNumericVersion(right.version, left.version))
    .map((entry) => join(windowsApps, entry.name, 'app', 'resources', 'codex.exe'))
    .find((candidate) => existsSync(candidate))
}

function compareNumericVersion(left: readonly number[], right: readonly number[]): number {
  const width = Math.max(left.length, right.length)
  for (let index = 0; index < width; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

async function freePort(): Promise<number> {
  const server = createNodeServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Failed to allocate a test port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function webWmConfig(port: number): GatewayConfig {
  const provider: ProviderDefinition = {
    id: 'chatgpt-provider',
    name: 'ChatGPT OAuth',
    kind: 'openai',
    sourceType: 'oauth-system',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    protocol: 'openai-responses',
    models: ['client-model'],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const account: Account = {
    id: 'web-wm-account',
    providerId: provider.id,
    name: 'Verified Web WM',
    credentialId: 'credential',
    maskedCredential: '***',
    credentialType: 'chatgpt-oauth',
    status: 'active',
    priority: 1,
    weight: 1,
    maxConcurrency: 1,
    inFlight: 0,
    availableModels: ['client-model'],
    modelPolicy: 'all',
    modelAllowlist: [],
    chatgptWebWm: {
      version: 2,
      protocolRevision: CHATGPT_WEB_WM_PROTOCOL_REVISION,
      model: GPT_5_6_SOL_WM_MODEL,
      catalogModel: GPT_5_6_SOL_WM_MODEL,
      turnModel: GPT_5_6_SOL_WM_MODEL,
      workspacePlanType: 'team',
      workspaceStructure: 'workspace',
      verifiedAt: timestamp,
      latencyMs: 100,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const pool: Pool = {
    id: 'web-wm-pool',
    name: 'Web WM',
    kind: 'standard',
    protocol: 'chatgpt-web-wm',
    strategy: 'priority',
    members: [{ accountId: account.id, enabled: true }],
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: false,
    stickyTtlMinutes: 30,
    maxRetries: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const route: Route = {
    id: 'route',
    client: 'codex',
    enabled: true,
    poolId: pool.id,
    inboundProtocol: 'openai-responses',
    modelMap: {},
    localToken: 'local-secret',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const settings: GatewaySettings = {
    host: '127.0.0.1',
    port,
    autoStart: false,
    logPayloads: false,
    requestTimeoutSeconds: 5,
  }
  return { providers: [provider], accounts: [account], pools: [pool], routes: [route], settings }
}

function webWmTextStream(text: string, model = GPT_5_6_SOL_WM_MODEL): Response {
  const responseId = 'resp_web_wm_text'
  const item = {
    id: 'msg_web_wm_text', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  return new Response([
    `event: response.created\ndata: ${JSON.stringify({
      type: 'response.created', sequence_number: 0,
      response: { id: responseId, object: 'response', model, status: 'in_progress', output: [] },
    })}`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: 'response.output_text.delta', sequence_number: 1, response_id: responseId,
      item_id: item.id, output_index: 0, content_index: 0, delta: text,
    })}`,
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: 'response.output_item.done', sequence_number: 2, response_id: responseId,
      output_index: 0, item,
    })}`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed', sequence_number: 3,
      response: {
        id: responseId, object: 'response', model,
        status: 'completed', output: [item],
      },
    })}`,
    '', '',
  ].join('\n\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

function webWmFailureStream(code: string, message: string): Response {
  const responseId = 'resp_web_wm_failed'
  return new Response([
    `event: response.failed\ndata: ${JSON.stringify({
      type: 'response.failed', sequence_number: 0,
      response: {
        id: responseId, object: 'response', model: GPT_5_6_SOL_WM_MODEL,
        status: 'failed', output: [], error: { code, message },
      },
    })}`,
    '', '',
  ].join('\n\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

function flattenResponsesToolDeclarations(
  declarations: readonly Record<string, unknown>[],
): Array<Record<string, unknown>> {
  const flattened: Array<Record<string, unknown>> = []
  const pending = [...declarations]
  while (pending.length > 0) {
    const declaration = pending.shift()!
    flattened.push(declaration)
    if (Array.isArray(declaration.tools)) {
      pending.unshift(...declaration.tools.filter((tool): tool is Record<string, unknown> => (
        Boolean(tool) && typeof tool === 'object' && !Array.isArray(tool)
      )))
    }
  }
  return flattened
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop({ force: true })))
})

describe('ChatGPT Web WM endpoint routing', () => {
  it('requires an update before an old Codex Desktop app-server can enter Web WM', async () => {
    const port = await freePort()
    const directFetch = vi.fn(async () => {
      throw new Error('An incompatible Codex Desktop request must stop before upstream routing')
    })
    const webTransport = vi.fn(async () => webWmTextStream('must not run'))
    const gateway = new GatewayServer({
      config: webWmConfig(port),
      credentialResolver: () => ({
        secret: 'oauth-token', kind: 'chatgpt-oauth', accountId: 'chatgpt-account',
      }),
      fetchImplementation: directFetch as typeof fetch,
      chatGptWebWmTransport: webTransport,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'user-agent': 'codex_cli_rs/0.146.0',
      },
      body: JSON.stringify({ model: 'client-model', input: 'Do not route this request.', stream: true }),
    })
    const payload = await response.json() as {
      error?: { message?: string; type?: string }
    }

    expect(response.status).toBe(426)
    expect(payload.error).toMatchObject({
      type: 'codex_desktop_update_required',
      message: expect.stringContaining('Codex Desktop'),
    })
    expect(payload.error?.message).toContain(MINIMUM_CODEX_APP_SERVER_WEB_WM_VERSION)
    expect(webTransport).not.toHaveBeenCalled()
    expect(directFetch).not.toHaveBeenCalled()
  })

  it('executes streaming and buffered /v1/responses through the Web WM transport', async () => {
    const port = await freePort()
    const directFetch = vi.fn(async () => {
      throw new Error('Web WM Responses must not use the Codex HTTP transport')
    })
    const webTransport = vi.fn(async () => webWmTextStream('Web WM answer'))
    const gateway = new GatewayServer({
      config: webWmConfig(port),
      credentialResolver: () => ({
        secret: 'oauth-token', kind: 'chatgpt-oauth', accountId: 'chatgpt-account',
      }),
      fetchImplementation: directFetch as typeof fetch,
      chatGptWebWmTransport: webTransport,
    })
    runningServers.push(gateway)
    await gateway.start()

    const request = (stream: boolean): Promise<Response> => fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'client-model', input: 'Reply from Work.', stream }),
    })
    const streaming = await request(true)
    const streamingWire = await streaming.text()
    const buffered = await request(false)
    const bufferedBody = await buffered.json() as Record<string, unknown>

    expect(streaming.status, streamingWire).toBe(200)
    expect(streamingWire).toContain('event: response.output_text.delta')
    expect(streamingWire).toContain('Web WM answer')
    expect(streamingWire).toContain('event: response.completed')
    expect(buffered.status, JSON.stringify(bufferedBody)).toBe(200)
    expect(bufferedBody).toMatchObject({
      object: 'response',
      model: GPT_5_6_SOL_WM_MODEL,
      status: 'completed',
      output: [{ type: 'message', role: 'assistant' }],
    })
    expect(JSON.stringify(bufferedBody)).toContain('Web WM answer')
    expect(directFetch).not.toHaveBeenCalled()
    expect(webTransport).toHaveBeenCalledTimes(2)
    expect(webTransport.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        operation: 'responses', stream: true,
        body: expect.objectContaining({ model: GPT_5_6_SOL_WM_MODEL, input: 'Reply from Work.' }),
      }),
      expect.objectContaining({
        operation: 'responses', stream: false,
        body: expect.objectContaining({ model: GPT_5_6_SOL_WM_MODEL, input: 'Reply from Work.' }),
      }),
    ])
  })

  it('retries a precommit Web WM 429 twice and exposes only the third successful turn', async () => {
    const port = await freePort()
    const webTransport = vi.fn(async () => (
      webTransport.mock.calls.length < 3
        ? webWmFailureStream('rate_limit_error', 'request capacity is temporarily constrained')
        : webWmTextStream('Recovered Web WM turn')
    ))
    const gateway = new GatewayServer({
      config: webWmConfig(port),
      credentialResolver: () => ({
        secret: 'oauth-token', kind: 'chatgpt-oauth', accountId: 'chatgpt-account',
      }),
      fetchImplementation: vi.fn(async () => {
        throw new Error('Web WM retry must remain on the Work transport')
      }) as typeof fetch,
      chatGptWebWmTransport: webTransport,
      requestTransientRetryDelayMs: 0,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'client-model', input: 'Complete this turn.', stream: true }),
    })
    const wire = await response.text()

    expect(response.status, wire).toBe(200)
    expect(wire).toContain('Recovered Web WM turn')
    expect(wire).toContain('response.completed')
    expect(wire).not.toContain('rate_limit_error')
    expect(webTransport).toHaveBeenCalledTimes(3)
  })

  it('returns the third Web WM 429 after exhausting the request-local retry budget', async () => {
    const port = await freePort()
    const webTransport = vi.fn(async () => (
      webWmFailureStream('rate_limit_error', 'request capacity is temporarily constrained')
    ))
    const gateway = new GatewayServer({
      config: webWmConfig(port),
      credentialResolver: () => ({
        secret: 'oauth-token', kind: 'chatgpt-oauth', accountId: 'chatgpt-account',
      }),
      fetchImplementation: vi.fn(async () => {
        throw new Error('Web WM retry must remain on the Work transport')
      }) as typeof fetch,
      chatGptWebWmTransport: webTransport,
      requestTransientRetryDelayMs: 0,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'client-model', input: 'Complete this turn.', stream: true }),
    })
    const payload = await response.json() as { error?: { message?: string } }

    expect(response.status).toBe(429)
    expect(payload.error).toMatchObject({
      message: expect.stringContaining('temporarily constrained'),
    })
    expect(webTransport).toHaveBeenCalledTimes(3)
  })

  it('does not count local Web WM lifecycle or reasoning frames as an upstream first byte', async () => {
    const port = await freePort()
    let clock = timestamp
    const logs: RequestLog[] = []
    const encoder = new TextEncoder()
    const responseId = 'resp_web_wm_timing'
    const lifecycle = [
      `event: response.created\ndata: ${JSON.stringify({
        type: 'response.created', sequence_number: 0,
        response: { id: responseId, object: 'response', model: GPT_5_6_SOL_WM_MODEL, status: 'in_progress', output: [] },
      })}`,
      `event: response.in_progress\ndata: ${JSON.stringify({
        type: 'response.in_progress', sequence_number: 1,
        response: { id: responseId, object: 'response', model: GPT_5_6_SOL_WM_MODEL, status: 'in_progress', output: [] },
      })}`,
      `event: response.output_item.added\ndata: ${JSON.stringify({
        type: 'response.output_item.added', sequence_number: 2, response_id: responseId,
        output_index: 0, item: { id: 'rs_web_wm_timing', type: 'reasoning', content: [], summary: [] },
      })}`,
      `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({
        type: 'response.reasoning_summary_text.delta', sequence_number: 3, response_id: responseId,
        item_id: 'rs_web_wm_timing', output_index: 0, summary_index: 0, delta: 'hidden progress',
      })}`,
      `event: response.output_item.done\ndata: ${JSON.stringify({
        type: 'response.output_item.done', sequence_number: 4, response_id: responseId,
        output_index: 0, item: { id: 'rs_web_wm_timing', type: 'reasoning', content: [], summary: [] },
      })}`,
      '', '',
    ].join('\n\n')
    const terminal = [
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: 'response.output_text.delta', sequence_number: 5, response_id: responseId,
        item_id: 'msg_web_wm_timing', output_index: 1, content_index: 0, delta: 'visible',
      })}`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed', sequence_number: 6,
        response: {
          id: responseId, object: 'response', model: GPT_5_6_SOL_WM_MODEL,
          status: 'completed', output: [],
        },
      })}`,
      '', '',
    ].join('\n\n')
    const webTransport = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(lifecycle))
        setTimeout(() => {
          clock += 9_000
          controller.enqueue(encoder.encode(terminal))
          controller.close()
        }, 5)
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }))
    const gateway = new GatewayServer({
      config: webWmConfig(port),
      credentialResolver: () => ({
        secret: 'oauth-token', kind: 'chatgpt-oauth', accountId: 'chatgpt-account',
      }),
      fetchImplementation: vi.fn(async () => {
        throw new Error('Web WM timing must not use the Codex HTTP transport')
      }) as typeof fetch,
      chatGptWebWmTransport: webTransport,
      now: () => clock,
      onLog: (log) => logs.push(log),
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'client-model', input: 'Measure visible output.', stream: true }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    await response.text()

    expect(logs.findLast((log) => log.status === 'success')).toMatchObject({
      upstreamFirstByteMs: 9_000,
      firstTokenMs: 9_000,
      clientFirstWriteMs: 9_000,
    })
  })

  it('keeps Codex Luna auxiliary turns on the official OAuth Responses path', async () => {
    const port = await freePort()
    const directFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'gpt-5.6-luna',
        text: { format: { type: 'json_schema' } },
      })
      return webWmTextStream('{"title":"utility"}', 'gpt-5.6-luna')
    })
    const webTransport = vi.fn(async () => {
      throw new Error('A Codex Luna auxiliary turn must not enter ChatGPT Work')
    })
    const config = webWmConfig(port)
    config.routes[0].modelMap = { '*': GPT_5_6_SOL_WM_MODEL }
    const gateway = new GatewayServer({
      config,
      credentialResolver: () => ({
        secret: 'oauth-token', kind: 'chatgpt-oauth', accountId: 'chatgpt-account',
      }),
      fetchImplementation: directFetch as typeof fetch,
      chatGptWebWmTransport: webTransport,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        input: 'Create a utility title.',
        text: {
          format: {
            type: 'json_schema',
            name: 'title',
            strict: true,
            schema: { type: 'object', properties: { title: { type: 'string' } } },
          },
        },
        stream: true,
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.text()).toContain('\\"title\\":\\"utility\\"')
    expect(directFetch).toHaveBeenCalledOnce()
    expect(webTransport).not.toHaveBeenCalled()
  })

  it('keeps the supported non-compaction Codex contract on the Web WM protocol', async () => {
    const port = await freePort()
    const directFetch = vi.fn(async () => {
      throw new Error('Only compaction may leave the Web WM protocol')
    })
    const webTransport = vi.fn(async () => webWmTextStream('stayed on Web WM'))
    const gateway = new GatewayServer({
      config: webWmConfig(port),
      credentialResolver: () => ({
        secret: 'oauth-token', kind: 'chatgpt-oauth', accountId: 'chatgpt-account',
      }),
      fetchImplementation: directFetch as typeof fetch,
      chatGptWebWmTransport: webTransport,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'client-model',
        instructions: 'Use the available client tools when needed.',
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Keep the request on Web WM.' }],
        }],
        tools: [{
          type: 'function',
          name: 'lookup',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        }],
        reasoning: { effort: 'max', summary: 'detailed', context: 'all_turns' },
        include: ['reasoning.encrypted_content'],
        text: { format: { type: 'text' }, verbosity: 'medium' },
        prompt_cache_key: 'codex-session',
        prompt_cache_retention: '24h',
        stream_options: { include_obfuscation: false },
        stream: false,
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(directFetch).not.toHaveBeenCalled()
    expect(webTransport).toHaveBeenCalledOnce()
    expect(webTransport.mock.calls[0][0]).toMatchObject({
      operation: 'responses',
      body: {
        model: GPT_5_6_SOL_WM_MODEL,
        input: [{ type: 'message', role: 'user' }],
        tools: [{ type: 'function', name: 'lookup' }],
        reasoning: { effort: 'max', summary: 'detailed', context: 'all_turns' },
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: 'codex-session',
      },
    })
  })

  it('estimates /v1/responses/input_tokens locally without consuming an account slot', async () => {
    const port = await freePort()
    const credentialResolver = vi.fn(() => {
      throw new Error('Local input token counting must not resolve account credentials')
    })
    const directFetch = vi.fn(async () => {
      throw new Error('Local input token counting must not call the upstream')
    })
    const webTransport = vi.fn(async () => {
      throw new Error('Local input token counting must not enter ChatGPT Work')
    })
    const gateway = new GatewayServer({
      config: webWmConfig(port),
      credentialResolver,
      fetchImplementation: directFetch as typeof fetch,
      chatGptWebWmTransport: webTransport,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses/input_tokens`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'client-model',
        instructions: 'Answer precisely.',
        input: 'Count this request locally. 这是一个本地估算。',
        tools: [{
          type: 'function',
          name: 'lookup',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        }],
      }),
    })
    const payload = await response.json() as { object?: string; input_tokens?: number }

    expect(response.status, JSON.stringify(payload)).toBe(200)
    expect(response.headers.get('x-stone-token-count-source')).toBe('estimate')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(payload.object).toBe('response.input_tokens')
    expect(payload.input_tokens).toBeTypeOf('number')
    expect(payload.input_tokens).toBeGreaterThan(1)
    expect(credentialResolver).not.toHaveBeenCalled()
    expect(directFetch).not.toHaveBeenCalled()
    expect(webTransport).not.toHaveBeenCalled()
  })

  it('does not let the Web WM token estimator intercept the ordinary Responses route', async () => {
    const port = await freePort()
    const config = webWmConfig(port)
    config.pools[0] = { ...config.pools[0], protocol: 'openai-responses' }
    const credentialResolver = vi.fn(() => {
      throw new Error('Relay token counting must not resolve an account')
    })
    const directFetch = vi.fn(async () => {
      throw new Error('Relay token counting must not call an upstream')
    })
    const gateway = new GatewayServer({
      config,
      credentialResolver,
      fetchImplementation: directFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses/input_tokens`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'client-model',
        input: 'The relay path must keep its authoritative response usage.',
      }),
    })
    const payload = await response.json() as { error?: { type?: string } }

    expect(response.status, JSON.stringify(payload)).toBe(501)
    expect(payload.error?.type).toBe('unsupported_operation')
    expect(credentialResolver).not.toHaveBeenCalled()
    expect(directFetch).not.toHaveBeenCalled()
  })

  it('executes /v1/alpha/search through Web WM and preserves the Codex search contract', async () => {
    const port = await freePort()
    const logs: RequestLog[] = []
    const directFetch = vi.fn(async () => {
      throw new Error('Search must not use the Codex alpha/search transport')
    })
    const webTransport = vi.fn(async () => new Response(JSON.stringify({
      encrypted_output: null,
      output: 'https://developers.openai.com/api/docs/guides/compaction',
      results: null,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const gateway = new GatewayServer({
      config: webWmConfig(port),
      credentialResolver: () => ({
        secret: 'oauth-token',
        kind: 'chatgpt-oauth',
        accountId: 'chatgpt-account',
      }),
      fetchImplementation: directFetch as typeof fetch,
      chatGptWebWmTransport: webTransport,
      onLog: (log) => logs.push(log),
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/alpha/search`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'search-session',
        model: 'client-model',
        commands: { search_query: [{ q: 'OpenAI compaction' }] },
        settings: { max_results: 5 },
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({
      encrypted_output: null,
      output: 'https://developers.openai.com/api/docs/guides/compaction',
      results: null,
    })
    expect(directFetch).not.toHaveBeenCalled()
    expect(webTransport).toHaveBeenCalledOnce()
    expect(webTransport.mock.calls[0][0]).toMatchObject({
      account: { id: 'web-wm-account' },
      pool: { id: 'web-wm-pool' },
      operation: 'search',
      stream: false,
      body: {
        id: 'search-session',
        model: GPT_5_6_SOL_WM_MODEL,
        commands: { search_query: [{ q: 'OpenAI compaction' }] },
        settings: { max_results: 5 },
      },
    })
    expect(logs.findLast((log) => log.status === 'success')).toMatchObject({
      requestKind: 'search',
      model: 'client-model',
      upstreamModel: GPT_5_6_SOL_WM_MODEL,
    })
  })

  it('runs different Web WM accounts concurrently without a pool-wide lock', async () => {
    const port = await freePort()
    const gatewayConfig = webWmConfig(port)
    gatewayConfig.accounts[0].maxConcurrency = 8
    gatewayConfig.pools[0].strategy = 'balanced'
    const secondAccount: Account = {
      ...gatewayConfig.accounts[0],
      id: 'web-wm-account-2',
      name: 'Verified Web WM 2',
      credentialId: 'credential-2',
      priority: 2,
    }
    gatewayConfig.accounts.push(secondAccount)
    gatewayConfig.pools[0].members.push({ accountId: secondAccount.id, enabled: true })
    const entered: string[] = []
    let active = 0
    let maximumActive = 0
    let releaseBarrier!: () => void
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve })
    const webTransport = vi.fn(async (input: { account: Account }) => {
      entered.push(input.account.id)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      if (entered.length === 2) releaseBarrier()
      await barrier
      active -= 1
      return new Response(JSON.stringify({
        encrypted_output: null,
        output: `result:${input.account.id}`,
        results: null,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (selected) => ({
        secret: `oauth-token-${selected.id}`,
        kind: 'chatgpt-oauth',
        accountId: `chatgpt-${selected.id}`,
      }),
      fetchImplementation: vi.fn() as typeof fetch,
      chatGptWebWmTransport: webTransport,
    })
    runningServers.push(gateway)
    await gateway.start()

    const search = (id: string): Promise<Response> => fetch(`http://127.0.0.1:${port}/v1/alpha/search`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ id, model: 'client-model', commands: { search_query: [{ q: id }] } }),
    })
    const responses = await Promise.all([search('parallel-a'), search('parallel-b')])
    const payloads = await Promise.all(responses.map((response) => response.json()))

    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(new Set(entered)).toEqual(new Set(['web-wm-account', 'web-wm-account-2']))
    expect(maximumActive).toBe(2)
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({ output: expect.stringMatching(/^result:web-wm-account(?:-2)?$/) }),
    ]))
  })

  it('honors one Web WM account maxConcurrency for parallel requests', async () => {
    const port = await freePort()
    const gatewayConfig = webWmConfig(port)
    gatewayConfig.accounts[0].maxConcurrency = 2
    let active = 0
    let maximumActive = 0
    let entered = 0
    let releaseBarrier!: () => void
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve })
    const webTransport = vi.fn(async (input: { account: Account }) => {
      entered += 1
      active += 1
      maximumActive = Math.max(maximumActive, active)
      if (entered === 2) releaseBarrier()
      await barrier
      active -= 1
      return new Response(JSON.stringify({
        encrypted_output: null,
        output: `result:${input.account.id}`,
        results: null,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({
        secret: 'oauth-token',
        kind: 'chatgpt-oauth',
        accountId: 'chatgpt-account',
      }),
      fetchImplementation: vi.fn() as typeof fetch,
      chatGptWebWmTransport: webTransport,
    })
    runningServers.push(gateway)
    await gateway.start()

    const search = (id: string): Promise<Response> => fetch(`http://127.0.0.1:${port}/v1/alpha/search`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ id, model: 'client-model', commands: { search_query: [{ q: id }] } }),
    })
    const responses = await Promise.all([search('same-account-a'), search('same-account-b')])

    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(webTransport).toHaveBeenCalledTimes(2)
    expect(webTransport.mock.calls.map(([input]) => input.account.id)).toEqual([
      'web-wm-account',
      'web-wm-account',
    ])
    expect(maximumActive).toBe(2)
  })

  it('keeps V2 compaction and its opaque continuation on normal Sol', async () => {
    const port = await freePort()
    const webTransport = vi.fn(async () => {
      throw new Error('Compaction continuity must not use Web WM')
    })
    const directBodies: Record<string, unknown>[] = []
    const directFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      directBodies.push(requestBody)
      expect(requestBody.model).toBe(GPT_5_6_SOL_MODEL)
      const input = requestBody.input as Array<Record<string, unknown>>
      if (input.some((item) => item.type === 'compaction')) {
        return webWmTextStream('continued through normal Sol')
      }
      return new Response([
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"cmp_web_wm","type":"compaction","encrypted_content":"encrypted-web-wm"}}',
        '',
        'event: response.completed',
        `data: {"type":"response.completed","response":{"id":"resp_web_wm_compact","model":"${GPT_5_6_SOL_MODEL}","status":"completed","output":[]}}`,
        '',
        '',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const gateway = new GatewayServer({
      config: webWmConfig(port),
      credentialResolver: () => ({
        secret: 'oauth-token',
        kind: 'chatgpt-oauth',
        accountId: 'chatgpt-account',
      }),
      fetchImplementation: directFetch as typeof fetch,
      chatGptWebWmTransport: webTransport,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'client-model',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'compact this' }] },
          { type: 'compaction_trigger' },
        ],
        stream: true,
      }),
    })

    const wire = await response.text()
    expect(response.status, wire).toBe(200)
    expect(wire).toContain('"type":"compaction"')
    expect(directFetch).toHaveBeenCalledOnce()
    expect(webTransport).not.toHaveBeenCalled()

    const followup = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'client-model',
        input: [
          { type: 'compaction', encrypted_content: 'encrypted-web-wm' },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
        ],
        stream: true,
      }),
    })

    const followupWire = await followup.text()
    expect(followup.status, followupWire).toBe(200)
    expect(followupWire).toContain('continued through normal Sol')
    expect(directFetch).toHaveBeenCalledTimes(2)
    expect(directBodies[1]).toMatchObject({
      model: GPT_5_6_SOL_MODEL,
      input: [
        { type: 'compaction', encrypted_content: 'encrypted-web-wm' },
        { type: 'message', role: 'user' },
      ],
    })
    expect(webTransport).not.toHaveBeenCalled()
  })

  it('converts standalone compact to a normal Sol Responses summary', async () => {
    const port = await freePort()
    const webTransport = vi.fn(async () => {
      throw new Error('Standalone compact must not use Web WM')
    })
    const directFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response([
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"Compact Sol summary"}',
        '',
        'event: response.completed',
        `data: {"type":"response.completed","response":{"id":"resp_web_wm_summary","model":"${GPT_5_6_SOL_MODEL}","status":"completed","output":[{"id":"msg_summary","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Compact Sol summary","annotations":[]}]}]}}`,
        '',
        '',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const gateway = new GatewayServer({
      config: webWmConfig(port),
      credentialResolver: () => ({
        secret: 'oauth-token',
        kind: 'chatgpt-oauth',
        accountId: 'chatgpt-account',
      }),
      fetchImplementation: directFetch as typeof fetch,
      chatGptWebWmTransport: webTransport,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'x-codex-turn-state': 'must-not-leak',
      },
      body: JSON.stringify({
        model: 'client-model',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'history' }] },
        ],
      }),
    })

    const payload = await response.json() as { output?: unknown[] }
    expect(response.status, JSON.stringify(payload)).toBe(200)
    expect(payload.output).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'message', role: 'user' }),
    ]))
    expect(JSON.stringify(payload)).toContain('Compact Sol summary')
    expect(directFetch).toHaveBeenCalledOnce()
    const [upstreamUrl, upstreamInit] = directFetch.mock.calls[0]
    expect(String(upstreamUrl)).toBe('https://chatgpt.com/backend-api/codex/responses')
    const upstreamHeaders = new Headers(upstreamInit?.headers)
    expect(upstreamHeaders.get('accept')).toBe('text/event-stream')
    expect(upstreamHeaders.has('x-codex-turn-state')).toBe(false)
    const upstreamBody = JSON.parse(String(upstreamInit?.body)) as Record<string, unknown>
    expect(upstreamBody).toMatchObject({ model: GPT_5_6_SOL_MODEL, stream: true })
    expect(JSON.stringify(upstreamBody)).not.toContain('compaction_trigger')
    expect(webTransport).not.toHaveBeenCalled()
  })

  it.skipIf(!runCodexDesktopSmoke)(
    'runs a current Codex Desktop tool round trip through the isolated Web WM gateway',
    async () => {
      const port = await freePort()
      const smokeRoot = await mkdtemp(join(tmpdir(), 'stone-codex-web-wm-'))
      if (dirname(smokeRoot).toLowerCase() !== tmpdir().toLowerCase()) {
        throw new Error(`Smoke directory is outside the system temp root: ${smokeRoot}`)
      }
      const codexHome = join(smokeRoot, 'codex-home')
      const workspace = join(smokeRoot, 'workspace')
      const finalMessagePath = join(smokeRoot, 'final-message.txt')
      const calculatorPath = join(workspace, 'calculator.mjs')
      const testPath = join(workspace, 'test.mjs')
      await Promise.all([
        mkdir(codexHome, { recursive: true }),
        mkdir(workspace, { recursive: true }),
      ])
      await Promise.all([
        writeFile(calculatorPath, [
          'export function add(left, right) {',
          '  return left - right',
          '}',
          '',
        ].join('\n'), 'utf8'),
        writeFile(testPath, [
          "import { add } from './calculator.mjs'",
          'const result = add(2, 3)',
          'if (result !== 5) {',
          '  console.error(`STONE_DEBUG_TEST_FAIL expected=5 actual=${result}`)',
          '  process.exit(1)',
          '}',
          "console.log('STONE_DEBUG_TEST_PASS')",
          '',
        ].join('\n'), 'utf8'),
      ])

      const workTurns: Array<Record<string, unknown>> = []
      const toolOutputPayloads: string[] = []
      let execWireName = ''
      const shellExecInput = (command: string): string => [
        'const result = await tools.shell_command({',
        `  command: ${JSON.stringify(command)},`,
        `  workdir: ${JSON.stringify(workspace)},`,
        '  timeout_ms: 10000,',
        '})',
        'text(result)',
      ].join('\n')
      const runtime = Object.create(
        ChatGptWebWmProtocolRuntime.prototype,
      ) as ChatGptWebWmProtocolRuntime
      const mutableRuntime = runtime as unknown as Record<string, unknown>
      mutableRuntime.initialize = async () => undefined
      mutableRuntime.ensureProtocolReady = async () => undefined
      mutableRuntime.responseBindings = new Map()
      mutableRuntime.reasoningStateBindings = new Map()
      mutableRuntime.toolCallBindings = new Map()
      mutableRuntime.conversationCleanupTimers = new Map()
      mutableRuntime.bridgeToken = 'codex-cli-smoke-bridge'
      mutableRuntime.disposed = false
      mutableRuntime.executeTurn = async (turn: Record<string, unknown>) => {
        workTurns.push(turn)
        if (workTurns.length === 1) {
          const tools = Array.isArray(turn.tools) ? turn.tools as WebWmLocalTool[] : []
          const execTool = tools.find((tool) => tool.kind === 'custom' && tool.name === 'exec')
          if (!execTool) {
            throw new Error(`Codex Desktop exposed no custom exec tool: ${tools.map((tool) => (
              `${tool.kind}:${tool.wireName}`
            )).join(', ')}`)
          }
          if (!JSON.stringify(execTool.signature).includes('shell_command')) {
            throw new Error('Codex Desktop custom exec no longer exposes tools.shell_command.')
          }
          if (!JSON.stringify(execTool.signature).includes('apply_patch')) {
            throw new Error('Codex Desktop custom exec no longer exposes tools.apply_patch.')
          }
          execWireName = execTool.wireName
          const parallelReadInput = [
            'const results = await Promise.all([',
            '  tools.shell_command({',
            `    command: ${JSON.stringify("Get-Content -Raw -LiteralPath './calculator.mjs'")},`,
            `    workdir: ${JSON.stringify(workspace)},`,
            '    timeout_ms: 10000,',
            '  }),',
            '  tools.shell_command({',
            `    command: ${JSON.stringify("Get-Content -Raw -LiteralPath './test.mjs'")},`,
            `    workdir: ${JSON.stringify(workspace)},`,
            '    timeout_ms: 10000,',
            '  }),',
            '])',
            'for (const result of results) text(result)',
          ].join('\n')
          return {
            status: 200,
            ok: true,
            observedModel: GPT_5_6_SOL_WM_MODEL,
            conversationId: 'codex-cli-smoke-conversation',
            currentNode: 'codex-cli-smoke-parallel-read-turn',
            output: '',
            toolCalls: [{
              id: 'codex-cli-smoke-parallel-read',
              name: execWireName,
              arguments: JSON.stringify({ input: parallelReadInput }),
            }],
          }
        }
        toolOutputPayloads.push(JSON.stringify({
          prompt: turn.prompt ?? '',
          messages: turn.messages ?? [],
        }))
        if (workTurns.length === 2) {
          return {
            status: 200,
            ok: true,
            observedModel: GPT_5_6_SOL_WM_MODEL,
            conversationId: 'codex-cli-smoke-conversation',
            currentNode: 'codex-cli-smoke-test-failing',
            output: '',
            toolCalls: [{
              id: 'codex-cli-smoke-test-failing',
              name: execWireName,
              arguments: JSON.stringify({ input: shellExecInput('node ./test.mjs') }),
            }],
          }
        }
        if (workTurns.length === 3) {
          const patch = [
            '*** Begin Patch',
            '*** Update File: calculator.mjs',
            '@@',
            '-  return left - right',
            '+  return left + right',
            '*** End Patch',
          ].join('\n')
          const execInput = [
            `const patch = ${JSON.stringify(patch)}`,
            'const result = await tools.apply_patch(patch)',
            'text(result)',
          ].join('\n')
          return {
            status: 200,
            ok: true,
            observedModel: GPT_5_6_SOL_WM_MODEL,
            conversationId: 'codex-cli-smoke-conversation',
            currentNode: 'codex-cli-smoke-patch-turn',
            output: '',
            toolCalls: [{
              id: 'codex-cli-smoke-apply-patch',
              name: execWireName,
              arguments: JSON.stringify({ input: execInput }),
            }],
          }
        }
        if (workTurns.length === 4) {
          return {
            status: 200,
            ok: true,
            observedModel: GPT_5_6_SOL_WM_MODEL,
            conversationId: 'codex-cli-smoke-conversation',
            currentNode: 'codex-cli-smoke-test-passing',
            output: '',
            toolCalls: [{
              id: 'codex-cli-smoke-test-passing',
              name: execWireName,
              arguments: JSON.stringify({ input: shellExecInput('node ./test.mjs') }),
            }],
          }
        }
        return {
          status: 200,
          ok: true,
          observedModel: GPT_5_6_SOL_WM_MODEL,
          conversationId: 'codex-cli-smoke-conversation',
          currentNode: 'codex-cli-smoke-final-turn',
          output: 'STONE_CODEX_DEBUG_E2E_OK',
          toolCalls: [],
        }
      }

      const directFetch = vi.fn(async () => {
        throw new Error('A normal Codex CLI turn must remain on Web WM')
      })
      const transportBodies: Record<string, unknown>[] = []
      const transportErrors: Array<{ status: number; body: string }> = []
      const webTransport = vi.fn(async (input: ChatGptWebWmTransportRequest) => {
        expect(input.operation).toBe('responses')
        transportBodies.push(input.body)
        const response = await runtime.responses(input.body, input.credential.accessToken, input.signal)
        if (!response.ok) {
          transportErrors.push({ status: response.status, body: await response.clone().text() })
        }
        return response
      })
      const requestLogs: RequestLog[] = []
      const smokeConfig = webWmConfig(port)
      smokeConfig.settings.logPayloads = true
      smokeConfig.providers[0]!.models = [GPT_5_6_SOL_MODEL]
      smokeConfig.accounts[0]!.availableModels = [GPT_5_6_SOL_MODEL]
      const gateway = new GatewayServer({
        config: smokeConfig,
        credentialResolver: () => ({
          secret: 'oauth-token', kind: 'chatgpt-oauth', accountId: 'chatgpt-account',
        }),
        fetchImplementation: directFetch as typeof fetch,
        chatGptWebWmTransport: webTransport,
        onLog: (log) => requestLogs.push(log),
      })
      runningServers.push(gateway)

      try {
        await gateway.start()
        await writeFile(join(codexHome, 'config.toml'), [
          `model = "${GPT_5_6_SOL_MODEL}"`,
          'model_provider = "stone"',
          'model_context_window = 200000',
          'cli_auth_credentials_store = "file"',
          'approval_policy = "never"',
          'sandbox_mode = "danger-full-access"',
          'model_reasoning_effort = "medium"',
          'model_reasoning_summary = "detailed"',
          'model_verbosity = "medium"',
          'web_search = "live"',
          'check_for_update_on_startup = false',
          '',
          '[features]',
          'apps = false',
          'plugins = false',
          'recommended_plugins = false',
          '',
          '[model_providers.stone]',
          'name = "Stone+ isolated smoke"',
          `base_url = "http://127.0.0.1:${port}/v1"`,
          'wire_api = "responses"',
          'requires_openai_auth = true',
          '',
        ].join('\n'), 'utf8')
        await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
          auth_mode: 'apikey',
          OPENAI_API_KEY: 'local-secret',
        }), 'utf8')

        const launch = await resolveCodexDesktopLaunch(workspace, smokeRoot)
        const childEnv: NodeJS.ProcessEnv = {
          ...process.env,
          CODEX_HOME: codexHome,
          OPENAI_API_KEY: 'local-secret',
          NO_COLOR: '1',
          NO_PROXY: '127.0.0.1,localhost',
        }
        for (const key of Object.keys(childEnv)) {
          if (['http_proxy', 'https_proxy', 'all_proxy'].includes(key.toLowerCase())) {
            delete childEnv[key]
          }
        }
        const result = await runChild(launch.file, [
          ...launch.argsPrefix,
          'exec',
          '--ephemeral',
          '--json',
          '--skip-git-repo-check',
          '--ignore-rules',
          '--color', 'never',
          '--sandbox', 'danger-full-access',
          '--model', GPT_5_6_SOL_MODEL,
          '--cd', workspace,
          '--output-last-message', finalMessagePath,
          'Debug calculator.mjs: run test.mjs, patch only calculator.mjs, rerun test.mjs, then reply exactly STONE_CODEX_DEBUG_E2E_OK.',
        ], { cwd: workspace, env: childEnv, timeoutMs: 60_000 })

        expect(result.code, [
          result.stderr,
          result.stdout,
          `transportErrors=${JSON.stringify(transportErrors)}`,
          `transportBodies=${JSON.stringify(transportBodies.map((body) => ({
            model: body.model,
            inputCount: Array.isArray(body.input) ? body.input.length : 0,
            toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
          })))}`,
          `requestLogs=${JSON.stringify(requestLogs)}`,
        ].join('\n')).toBe(0)
        expect((await readFile(finalMessagePath, 'utf8')).trim()).toBe('STONE_CODEX_DEBUG_E2E_OK')
        expect(result.stdout).toContain('STONE_CODEX_DEBUG_E2E_OK')
        expect(toolOutputPayloads).toHaveLength(4)
        expect(toolOutputPayloads[0]).toContain('return left - right')
        expect(toolOutputPayloads[0]).toContain('STONE_DEBUG_TEST_FAIL expected=5')
        expect(toolOutputPayloads[1]).toContain('STONE_DEBUG_TEST_FAIL')
        expect(toolOutputPayloads[2]).toContain('Script completed')
        expect(toolOutputPayloads[3]).toContain('STONE_DEBUG_TEST_PASS')
        expect(
          await readFile(calculatorPath, 'utf8'),
          JSON.stringify(toolOutputPayloads),
        ).toContain('return left + right')
        expect(workTurns).toHaveLength(5)
        expect(webTransport).toHaveBeenCalledTimes(5)
        expect(workTurns[1].messages).toHaveLength(1)
        expect(result.stdout).toContain('calculator.mjs')
        expect(result.stdout).toContain('test.mjs')
        const firstBody = transportBodies[0]
        const firstInput = Array.isArray(firstBody?.input)
          ? firstBody.input as Array<Record<string, unknown>>
          : []
        const additionalTools = firstInput.flatMap((item) => (
          item.type === 'additional_tools' && Array.isArray(item.tools)
            ? item.tools as Array<Record<string, unknown>>
            : []
        ))
        const flattenedTools = flattenResponsesToolDeclarations([
          ...(Array.isArray(firstBody?.tools)
            ? firstBody.tools as Array<Record<string, unknown>>
            : []),
          ...additionalTools,
        ])
        expect(flattenedTools).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'custom', name: 'exec' }),
        ]))
        expect(flattenedTools.some((tool) => (
          tool.type === 'web_search' || tool.type === 'web_search_preview'
        ))).toBe(false)
        expect(directFetch).not.toHaveBeenCalled()
        expect(requestLogs).toEqual(expect.arrayContaining([
          expect.objectContaining({ status: 'success', statusCode: 200 }),
        ]))
        const errorLogs = requestLogs.filter((log) => log.status === 'error')
        expect(errorLogs, JSON.stringify(errorLogs)).toEqual([])
      } finally {
        const timers = mutableRuntime.conversationCleanupTimers
        if (timers instanceof Map) {
          for (const timer of timers.values()) clearTimeout(timer as ReturnType<typeof setTimeout>)
        }
        await removeSmokeRoot(smokeRoot)
      }
    },
    90_000,
  )
})
