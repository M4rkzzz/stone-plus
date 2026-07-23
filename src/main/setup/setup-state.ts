import { randomUUID } from 'node:crypto'
import type { Protocol, SetupSourceMethod, SetupWizardProgressInput, SetupWizardRoutingRollback, SetupWizardState, SetupWizardStep } from '@shared/types'

export const SETUP_WIZARD_METADATA_KEY = 'setup_wizard_state_v1'

export interface SetupMetadataStore {
  readAppMetadata(key: string): string | undefined
  writeAppMetadata(key: string, value: string): Promise<void>
  removeAppMetadata(key: string): Promise<void>
}

const setupSteps = new Set<SetupWizardStep>([
  'scan',
  'source',
  'source-config',
  'network',
  'upstream-test',
  'client',
  'routing',
  'gateway',
  'verify',
  'client-config',
  'complete',
])
const setupSourceMethods = new Set<SetupSourceMethod>([
  'existing',
  'oauth',
  'token-json',
  'official-api',
  'relay',
  'aggregate',
])

/**
 * Small metadata-backed repository for resumable setup progress. Credentials and
 * raw probe payloads are deliberately not part of this model.
 */
export class SetupWizardRepository {
  constructor(private readonly metadata: SetupMetadataStore, private readonly now = () => Date.now()) {}

  get(): SetupWizardState | null {
    const raw = this.metadata.readAppMetadata(SETUP_WIZARD_METADATA_KEY)
    if (!raw) return null
    try {
      return normalizeSetupState(JSON.parse(raw) as unknown)
    } catch {
      return null
    }
  }

  async save(input: SetupWizardProgressInput): Promise<SetupWizardState> {
    const existing = this.get()
    if (input.sessionId && existing && input.sessionId !== existing.sessionId) {
      throw new Error('配置向导会话已更新，请重新打开向导。')
    }
    if (!setupSteps.has(input.step)) throw new Error('配置向导步骤无效。')
    if (input.step === 'complete' && existing?.completed !== true) {
      throw new Error('配置向导完成状态只能在端到端验证后写入。')
    }
    const timestamp = this.now()
    const state: SetupWizardState = {
      sessionId: existing?.sessionId ?? input.sessionId ?? randomUUID(),
      step: input.step,
      completed: existing?.completed ?? false,
      dismissed: false,
      sourceType: input.sourceType ?? existing?.sourceType,
      sourceMethod: updatedSourceMethod(input.sourceMethod, existing?.sourceMethod),
      sourceId: updatedIdentifier(input.sourceId, existing?.sourceId),
      tagId: updatedIdentifier(input.tagId, existing?.tagId),
      poolId: updatedIdentifier(input.poolId, existing?.poolId),
      routeId: updatedIdentifier(input.routeId, existing?.routeId),
      client: input.client ?? existing?.client,
      profileId: updatedIdentifier(input.profileId, existing?.profileId),
      model: cleanIdentifier(input.model ?? existing?.model),
      proxyId: updatedIdentifier(input.proxyId, existing?.proxyId),
      lastError: sanitizeMessage(input.lastError),
      verifiedAt: existing?.completed || input.step === 'client-config' || input.step === 'complete'
        ? existing?.verifiedAt
        : undefined,
      routingRollbacks: existing?.routingRollbacks,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }
    await this.persist(state)
    return state
  }

  async dismiss(): Promise<SetupWizardState> {
    const timestamp = this.now()
    const existing = this.get()
    const state: SetupWizardState = existing
      ? { ...existing, dismissed: true, updatedAt: timestamp }
      : {
          sessionId: randomUUID(),
          step: 'scan',
          completed: false,
          dismissed: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
    await this.persist(state)
    return state
  }

  async complete(sessionId: string): Promise<SetupWizardState> {
    const existing = this.get()
    if (!existing || existing.sessionId !== sessionId) throw new Error('配置向导会话不存在或已过期。')
    if (!existing.verifiedAt) throw new Error('只有端到端真实请求成功后才能完成配置向导。')
    const state: SetupWizardState = {
      ...existing,
      step: 'complete',
      completed: true,
      dismissed: false,
      lastError: undefined,
      updatedAt: this.now(),
    }
    await this.persist(state)
    return state
  }

  async markVerified(sessionId: string): Promise<SetupWizardState> {
    const existing = this.get()
    if (!existing || existing.sessionId !== sessionId) throw new Error('配置向导会话不存在或已过期。')
    const timestamp = this.now()
    const state: SetupWizardState = {
      ...existing,
      step: 'client-config',
      completed: false,
      dismissed: false,
      lastError: undefined,
      verifiedAt: timestamp,
      updatedAt: timestamp,
    }
    await this.persist(state)
    return state
  }

  async recordRoutingMutation(sessionId: string, input: {
    routeId: string
    routeCreated: boolean
    expectedUpdatedAt: number
    createdPoolId?: string
    previous?: SetupWizardRoutingRollback['previous']
  }): Promise<SetupWizardState> {
    const existing = this.get()
    if (!existing || existing.sessionId !== sessionId) throw new Error('配置向导会话不存在或已过期。')
    const rollbacks = [...(existing.routingRollbacks ?? [])]
    const index = rollbacks.findIndex((item) => item.routeId === input.routeId)
    const current = index >= 0 ? rollbacks[index] : undefined
    const rollback: SetupWizardRoutingRollback = {
      routeId: input.routeId,
      routeCreated: current?.routeCreated ?? input.routeCreated,
      expectedUpdatedAt: input.expectedUpdatedAt,
      createdPoolIds: [...new Set([
        ...(current?.createdPoolIds ?? []),
        ...(input.createdPoolId ? [input.createdPoolId] : []),
      ])],
      previous: current?.previous ?? input.previous,
    }
    if (index >= 0) rollbacks[index] = rollback
    else rollbacks.push(rollback)
    const state = { ...existing, routingRollbacks: rollbacks.slice(-3), updatedAt: this.now() }
    await this.persist(state)
    return state
  }

  async reset(): Promise<void> {
    await this.metadata.removeAppMetadata(SETUP_WIZARD_METADATA_KEY)
  }

  private async persist(state: SetupWizardState): Promise<void> {
    await this.metadata.writeAppMetadata(SETUP_WIZARD_METADATA_KEY, JSON.stringify(state))
  }
}

function normalizeSetupState(value: unknown): SetupWizardState | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<SetupWizardState>
  if (typeof input.sessionId !== 'string' || !input.sessionId.trim()) return null
  if (!input.step || !setupSteps.has(input.step)) return null
  const createdAt = finiteTimestamp(input.createdAt)
  const updatedAt = finiteTimestamp(input.updatedAt)
  if (createdAt === undefined || updatedAt === undefined) return null
  const sourceType = input.sourceType === 'oauth-system' || input.sourceType === 'official-api' || input.sourceType === 'relay'
    ? input.sourceType
    : undefined
  const sourceMethod = typeof input.sourceMethod === 'string' && setupSourceMethods.has(input.sourceMethod)
    ? input.sourceMethod
    : undefined
  const client = input.client === 'codex' || input.client === 'claude' || input.client === 'gemini'
    ? input.client
    : undefined
  return {
    sessionId: input.sessionId,
    step: input.step,
    completed: input.completed === true,
    dismissed: input.dismissed === true,
    sourceType,
    sourceMethod,
    sourceId: cleanIdentifier(input.sourceId),
    tagId: cleanIdentifier(input.tagId),
    poolId: cleanIdentifier(input.poolId),
    routeId: cleanIdentifier(input.routeId),
    client,
    profileId: cleanIdentifier(input.profileId),
    model: cleanIdentifier(input.model),
    proxyId: cleanIdentifier(input.proxyId),
    lastError: sanitizeMessage(input.lastError),
    verifiedAt: finiteTimestamp(input.verifiedAt),
    routingRollbacks: normalizeRoutingRollbacks(input.routingRollbacks),
    createdAt,
    updatedAt,
  }
}

function normalizeRoutingRollbacks(value: unknown): SetupWizardRoutingRollback[] | undefined {
  if (!Array.isArray(value)) return undefined
  const protocols = new Set<Protocol>(['openai-responses', 'openai-chat', 'anthropic-messages', 'gemini'])
  const result: SetupWizardRoutingRollback[] = []
  for (const candidate of value.slice(-3)) {
    if (!candidate || typeof candidate !== 'object') continue
    const input = candidate as Partial<SetupWizardRoutingRollback>
    const routeId = cleanIdentifier(input.routeId)
    const expectedUpdatedAt = finiteTimestamp(input.expectedUpdatedAt)
    if (!routeId || expectedUpdatedAt === undefined) continue
    const previous = input.previous && typeof input.previous === 'object'
      && typeof input.previous.poolId === 'string'
      && typeof input.previous.enabled === 'boolean'
      && protocols.has(input.previous.inboundProtocol)
      && input.previous.modelMap && typeof input.previous.modelMap === 'object'
      ? {
          poolId: input.previous.poolId.slice(0, 256),
          enabled: input.previous.enabled,
          highConcurrencyMode: input.previous.highConcurrencyMode === true,
          inboundProtocol: input.previous.inboundProtocol,
          modelMap: Object.fromEntries(Object.entries(input.previous.modelMap)
            .filter(([key, model]) => key.length <= 256 && typeof model === 'string' && model.length <= 256)
            .slice(0, 256)) as Record<string, string>,
        }
      : undefined
    result.push({
      routeId,
      routeCreated: input.routeCreated === true,
      expectedUpdatedAt,
      createdPoolIds: Array.isArray(input.createdPoolIds)
        ? input.createdPoolIds.map(cleanIdentifier).filter((id): id is string => Boolean(id)).slice(0, 8)
        : [],
      previous,
    })
  }
  return result.length ? result : undefined
}

function cleanIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value.trim().slice(0, 256)
}

function updatedIdentifier(value: unknown, existing: string | undefined): string | undefined {
  if (value === undefined) return existing
  if (value === null) return undefined
  return cleanIdentifier(value)
}

function updatedSourceMethod(
  value: SetupSourceMethod | null | undefined,
  existing: SetupSourceMethod | undefined
): SetupSourceMethod | undefined {
  if (value === undefined) return existing
  if (value === null) return undefined
  return setupSourceMethods.has(value) ? value : undefined
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function sanitizeMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const sanitized = value
    .replace(
      /((?:["']?)\b(?:authorization[-_]?code|code|state|access[-_]?token|refresh[-_]?token|id[-_]?token|code[-_]?verifier|token)\b(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&#]+)/gi,
      '$1[redacted]'
    )
    .replace(/Bearer\s+[-A-Za-z0-9._~+/]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replaceAll(/[\s\S]/g, (character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 ? ' ' : character
    })
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized || undefined
}
