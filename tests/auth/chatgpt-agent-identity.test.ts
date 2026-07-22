import { createPrivateKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { createRequire } from 'node:module'
import type * as SodiumApi from 'libsodium-wrappers-sumo'
import { describe, expect, it, vi } from 'vitest'
import {
  buildAgentAssertion,
  deserializeChatGptAgentIdentity,
  isInvalidAgentIdentityTaskResponse,
  parseChatGptAgentIdentityImport,
  resolveChatGptAgentIdentity,
  serializeChatGptAgentIdentity,
  type ChatGptAgentIdentityBundle
} from '../../src/main/auth'

const sodium = createRequire(import.meta.url)('libsodium-wrappers-sumo') as typeof SodiumApi

function fixture(taskId = 'task-one'): { bundle: ChatGptAgentIdentityBundle; publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'] } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    publicKey,
    bundle: {
      version: 1,
      agentRuntimeId: 'runtime-one',
      agentPrivateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      taskId,
      accountId: 'workspace-one',
      userId: 'user-one',
      email: 'one@example.com',
      planType: 'team',
      fedramp: false
    }
  }
}

describe('ChatGPT Agent Identity', () => {
  it('parses official auth.json, JSONL and Sub2API credential shapes', () => {
    const { bundle } = fixture()
    const official = parseChatGptAgentIdentityImport(JSON.stringify({
      auth_mode: 'agentIdentity',
      agent_identity: {
        agent_runtime_id: bundle.agentRuntimeId,
        agent_private_key: bundle.agentPrivateKey,
        task_id: bundle.taskId,
        account_id: bundle.accountId,
        chatgpt_user_id: bundle.userId,
        email: bundle.email,
        plan_type: bundle.planType
      }
    }))
    expect(official.identities).toEqual([bundle])

    const sub2api = parseChatGptAgentIdentityImport(JSON.stringify({
      type: 'sub2api-data',
      accounts: [{ platform: 'openai', type: 'oauth', credentials: {
        auth_mode: 'agentIdentity', agentRuntimeId: 'runtime-two',
        agentPrivateKey: bundle.agentPrivateKey, accountId: 'workspace-two',
        chatgptUserId: 'user-two', chatgptAccountIsFedramp: true
      }}]
    }))
    expect(sub2api.identities[0]).toMatchObject({
      agentRuntimeId: 'runtime-two', accountId: 'workspace-two', userId: 'user-two', fedramp: true
    })

    const jsonl = parseChatGptAgentIdentityImport([
      JSON.stringify({ auth_mode: 'agentIdentity', agent_identity: {
        agent_runtime_id: 'runtime-three', agent_private_key: bundle.agentPrivateKey,
        account_id: 'workspace-three', chatgpt_user_id: 'user-three'
      }}),
      JSON.stringify({ access_token: 'ordinary-oauth' })
    ].join('\n'))
    expect(jsonl.identities).toHaveLength(1)

    const jwtPayload = Buffer.from(JSON.stringify({
      agent_runtime_id: 'runtime-jwt', agent_private_key: bundle.agentPrivateKey,
      account_id: 'workspace-jwt', chatgpt_user_id: 'user-jwt',
      plan_type: 'team', chatgpt_account_is_fedramp: false
    })).toString('base64url')
    const jwt = `${Buffer.from('{"alg":"RS256","kid":"one"}').toString('base64url')}.${jwtPayload}.signature`
    const officialJwt = parseChatGptAgentIdentityImport(JSON.stringify({
      auth_mode: 'agentIdentity', agent_identity: jwt
    }))
    expect(officialJwt.identities[0]).toMatchObject({
      agentRuntimeId: 'runtime-jwt', sourceJwt: jwt
    })
  })

  it('rejects non-Ed25519 and malformed PKCS#8 private keys', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    expect(() => parseChatGptAgentIdentityImport(JSON.stringify({
      auth_mode: 'agentIdentity', agent_runtime_id: 'runtime',
      agent_private_key: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      account_id: 'account', chatgpt_user_id: 'user'
    }))).toThrow(/Ed25519/)
    expect(deserializeChatGptAgentIdentity('{"agentRuntimeId":"runtime"}')).toBeUndefined()
  })

  it('builds an official AgentAssertion envelope and Ed25519 signature', () => {
    const { bundle, publicKey } = fixture()
    const authorization = buildAgentAssertion(bundle, new Date('2026-07-22T01:02:03.999Z'))
    expect(authorization.startsWith('AgentAssertion ')).toBe(true)
    const envelope = JSON.parse(Buffer.from(authorization.slice('AgentAssertion '.length), 'base64url').toString()) as Record<string, string>
    expect(envelope).toMatchObject({
      agent_runtime_id: 'runtime-one', task_id: 'task-one', timestamp: '2026-07-22T01:02:03Z'
    })
    expect(verify(
      null,
      Buffer.from(`runtime-one:task-one:${envelope.timestamp}`),
      publicKey,
      Buffer.from(envelope.signature, 'base64')
    )).toBe(true)
  })

  it('registers and persists a missing task before returning request auth', async () => {
    const { bundle } = fixture('')
    delete bundle.taskId
    let persisted = ''
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ taskId: 'task-new' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch
    const source = serializeChatGptAgentIdentity(bundle)
    const access = await resolveChatGptAgentIdentity(source, async (serialized, expected) => {
      expect(expected).toBe(source)
      persisted = serialized
    }, fetchImplementation, { now: () => new Date('2026-07-22T01:02:03Z') })
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
    expect(access.bundle.taskId).toBe('task-new')
    expect(access.authorization).toMatch(/^AgentAssertion /)
    expect(deserializeChatGptAgentIdentity(persisted)?.taskId).toBe('task-new')
  })

  it('does not let the first caller abort a shared task registration', async () => {
    const { bundle } = fixture('')
    delete bundle.taskId
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetchImplementation = vi.fn(async () => {
      await gate
      return new Response(JSON.stringify({ taskId: 'shared-task' }), { status: 200 })
    }) as unknown as typeof fetch
    const source = serializeChatGptAgentIdentity(bundle)
    const controller = new AbortController()
    const first = resolveChatGptAgentIdentity(source, async () => undefined, fetchImplementation, {
      signal: controller.signal,
    })
    const second = resolveChatGptAgentIdentity(source, async () => undefined, fetchImplementation)
    controller.abort()
    release()
    await expect(first).rejects.toThrow(/abort/i)
    await expect(second).resolves.toMatchObject({ bundle: { taskId: 'shared-task' } })
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('recognizes only explicit 401 task invalidation responses', () => {
    expect(isInvalidAgentIdentityTaskResponse(401, { error: { code: 'task_expired' } })).toBe(true)
    expect(isInvalidAgentIdentityTaskResponse(401, 'unknown task id')).toBe(true)
    expect(isInvalidAgentIdentityTaskResponse(403, 'unknown task id')).toBe(false)
    expect(isInvalidAgentIdentityTaskResponse(401, { error: { code: 'invalid_api_key' } })).toBe(false)
  })

  it('caches a verified JWKS key across Agent Identity requests', async () => {
    const { bundle } = fixture()
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'rotation-one' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({
      iss: 'https://chatgpt.com/codex-backend/agent-identity',
      aud: 'codex-app-server',
      exp: Math.floor(Date.now() / 1000) + 3600,
      agent_runtime_id: bundle.agentRuntimeId,
      agent_private_key: bundle.agentPrivateKey,
      task_id: bundle.taskId,
      account_id: bundle.accountId,
      chatgpt_user_id: bundle.userId,
      chatgpt_account_is_fedramp: false,
    })).toString('base64url')
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')
    bundle.sourceJwt = `${header}.${payload}.${signature}`
    const jwk = publicKey.export({ format: 'jwk' })
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
      keys: [{ ...jwk, kid: 'rotation-one', alg: 'RS256', use: 'sig' }],
    }), { status: 200, headers: { 'cache-control': 'public, max-age=60' } })) as unknown as typeof fetch
    const serialized = serializeChatGptAgentIdentity(bundle)
    await resolveChatGptAgentIdentity(serialized, async () => undefined, fetchImplementation)
    await resolveChatGptAgentIdentity(serialized, async () => undefined, fetchImplementation)
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('decrypts the official sealed-box encrypted task response and persists it', async () => {
    const { bundle } = fixture('')
    delete bundle.taskId
    await sodium.ready
    const privateKey = generateKeyPairPrivateBytes(bundle.agentPrivateKey)
    const signingPair = sodium.crypto_sign_seed_keypair(privateKey)
    const curvePublic = sodium.crypto_sign_ed25519_pk_to_curve25519(signingPair.publicKey)
    const encryptedTaskId = Buffer.from(sodium.crypto_box_seal('task-encrypted', curvePublic)).toString('base64')
    let persisted = ''
    const access = await resolveChatGptAgentIdentity(
      serializeChatGptAgentIdentity(bundle),
      async (serialized) => { persisted = serialized },
      async () => new Response(JSON.stringify({ encrypted_task_id: encryptedTaskId }), { status: 200 }),
      { timeoutMs: 500 }
    )
    expect(access.bundle.taskId).toBe('task-encrypted')
    expect(deserializeChatGptAgentIdentity(persisted)?.taskId).toBe('task-encrypted')
    sodium.memzero(privateKey)
    sodium.memzero(signingPair.privateKey)
  })

  it('rejects malformed or undecryptable encrypted task responses', async () => {
    const { bundle } = fixture('')
    delete bundle.taskId
    await expect(resolveChatGptAgentIdentity(
      serializeChatGptAgentIdentity(bundle),
      async () => undefined,
      async () => new Response(JSON.stringify({ encrypted_task_id: Buffer.alloc(64, 7).toString('base64') }), { status: 200 }),
      { timeoutMs: 500 }
    )).rejects.toThrow(/decrypt the encrypted Agent Identity task ID/)
  })
})

function generateKeyPairPrivateBytes(encodedPkcs8: string): Uint8Array {
  const key = createPrivateKey({
    key: Buffer.from(encodedPkcs8, 'base64'),
    format: 'der',
    type: 'pkcs8'
  }).export({ format: 'jwk' })
  if (typeof key.d !== 'string') throw new Error('fixture key has no seed')
  return new Uint8Array(Buffer.from(key.d, 'base64url'))
}
