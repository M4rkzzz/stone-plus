import type { ApiSourceInput, SetupWizardStep } from '@shared/types'

export type SetupWizardPhaseId = 'prepare' | 'source' | 'client' | 'connect' | 'complete'

export interface SetupWizardPhase {
  id: SetupWizardPhaseId
  label: string
  description: string
}

type Translate = <T>(chinese: T, english: T) => T

const phaseByStep: Record<SetupWizardStep, SetupWizardPhaseId> = {
  scan: 'prepare',
  source: 'source',
  'source-config': 'source',
  network: 'source',
  'upstream-test': 'source',
  client: 'client',
  routing: 'connect',
  gateway: 'connect',
  verify: 'connect',
  'client-config': 'connect',
  complete: 'complete',
}

const providerKinds = new Set<ApiSourceInput['kind']>([
  'anthropic',
  'openai',
  'xai',
  'google',
  'openai-compatible',
  'xai-compatible',
  'anthropic-compatible',
  'kiro-compatible',
  'custom',
])

const protocols = new Set<ApiSourceInput['protocol']>([
  'anthropic-messages',
  'openai-responses',
  'openai-chat',
  'gemini',
  'kiro-claude',
])

export function setupWizardPhases(t: Translate): SetupWizardPhase[] {
  return [
    { id: 'prepare', label: t('准备检查', 'Prepare'), description: t('确认网络与本机环境', 'Check network and local environment') },
    { id: 'source', label: t('添加来源', 'Add source'), description: t('登录账号或填写 API', 'Sign in or enter an API') },
    { id: 'client', label: t('选择用途', 'Choose client'), description: t('选择要连接的客户端', 'Choose the client to connect') },
    { id: 'connect', label: t('连接验证', 'Connect and verify'), description: t('一键建立并检查链路', 'Build and check the route') },
    { id: 'complete', label: t('完成', 'Complete'), description: t('开始使用 Stone+', 'Start using Stone+') },
  ]
}

export function setupWizardPhaseForStep(step: SetupWizardStep): SetupWizardPhaseId {
  return phaseByStep[step]
}

export function setupWizardStepLabel(step: SetupWizardStep, t: Translate): string {
  const labels: Record<SetupWizardStep, string> = {
    scan: t('检查环境', 'Check environment'),
    source: t('选择来源', 'Choose source'),
    'source-config': t('配置来源', 'Configure source'),
    network: t('验证来源', 'Verify source'),
    'upstream-test': t('验证来源', 'Verify source'),
    client: t('选择客户端', 'Choose client'),
    routing: t('创建并验证连接', 'Create and verify connection'),
    gateway: t('恢复网关启动', 'Resume gateway startup'),
    verify: t('恢复端到端验证', 'Resume end-to-end verification'),
    'client-config': t('连接客户端', 'Connect client'),
    complete: t('配置完成', 'Setup complete'),
  }
  return labels[step]
}

export function setupWizardDraftStorageKey(sessionId: string): string {
  return `stone.setup-wizard.source-draft.${sessionId}`
}

/**
 * Persist only credential-free form fields. API keys and pasted import payloads
 * intentionally remain memory-only and must be re-entered after a restart.
 */
export function serializeSetupSourceDraft(draft: ApiSourceInput): string {
  return JSON.stringify({
    id: cleanString(draft.id, 256),
    name: cleanString(draft.name, 160) ?? '',
    sourceType: draft.sourceType,
    kind: draft.kind,
    baseUrl: credentialFreeEndpoint(draft.baseUrl),
    protocol: draft.protocol,
    responsesCompactMode: draft.responsesCompactMode,
    models: draft.models.map((model) => cleanString(model, 256)).filter((model): model is string => Boolean(model)).slice(0, 256),
    defaultModel: cleanString(draft.defaultModel, 256),
    priority: finiteInteger(draft.priority, 10),
    weight: finiteInteger(draft.weight, 10),
    maxConcurrency: finiteInteger(draft.maxConcurrency, 20),
    proxyId: cleanString(draft.proxyId, 256),
    unlinkIncompatiblePools: draft.unlinkIncompatiblePools === true,
  })
}

export function parseSetupSourceDraft(raw: string | null): ApiSourceInput | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (value.sourceType !== 'official-api' && value.sourceType !== 'relay') return null
    if (!providerKinds.has(value.kind as ApiSourceInput['kind'])) return null
    if (!protocols.has(value.protocol as ApiSourceInput['protocol'])) return null
    const models = Array.isArray(value.models)
      ? value.models.map((model) => cleanString(model, 256)).filter((model): model is string => Boolean(model)).slice(0, 256)
      : []
    return {
      id: cleanString(value.id, 256),
      name: cleanString(value.name, 160) ?? '',
      sourceType: value.sourceType,
      kind: value.kind as ApiSourceInput['kind'],
      baseUrl: credentialFreeEndpoint(value.baseUrl),
      protocol: value.protocol as ApiSourceInput['protocol'],
      responsesCompactMode: value.responsesCompactMode === 'auto'
        || value.responsesCompactMode === 'legacy'
        || value.responsesCompactMode === 'passthrough'
        || value.responsesCompactMode === 'native'
        ? value.responsesCompactMode
        : undefined,
      credential: '',
      models,
      defaultModel: cleanString(value.defaultModel, 256),
      priority: finiteInteger(value.priority, 10),
      weight: finiteInteger(value.weight, 10),
      maxConcurrency: finiteInteger(value.maxConcurrency, 20),
      proxyId: cleanString(value.proxyId, 256),
      unlinkIncompatiblePools: value.unlinkIncompatiblePools === true,
    }
  } catch {
    return null
  }
}

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized ? normalized.slice(0, maxLength) : undefined
}

function credentialFreeEndpoint(value: unknown): string {
  const endpoint = cleanString(value, 2_048) ?? ''
  if (!endpoint || endpoint.includes('@') || endpoint.includes('?') || endpoint.includes('#')) return ''
  return endpoint
}

function finiteInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.round(value))
    : fallback
}
