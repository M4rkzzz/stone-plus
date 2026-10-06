import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Account, Pool, ProviderDefinition, RouteClient } from '../../src/shared/types'
import {
  analyzeRouteSourceCompatibility,
  listRouteSourcesForClient,
  resolveRouteSource,
} from '../../src/shared/route-sources'
import { protocolLabels } from '../../src/renderer/src/ui'
import { providerKindLabelsZh } from '../../src/renderer/src/grok-relay-ui'

const routesView = readFileSync(
  new URL('../../src/renderer/src/views/RoutesView.tsx', import.meta.url),
  'utf8',
)
const providersView = readFileSync(
  new URL('../../src/renderer/src/views/ProvidersView.tsx', import.meta.url),
  'utf8',
)
const setupWizardView = readFileSync(
  new URL('../../src/renderer/src/views/SetupWizardView.tsx', import.meta.url),
  'utf8',
)
const clientsView = readFileSync(
  new URL('../../src/renderer/src/views/ClientsView.tsx', import.meta.url),
  'utf8',
)

describe('Kiro Claude renderer boundaries', () => {
  it('uses the product protocol label and locks relay protocol selectors in both source editors', () => {
    expect(protocolLabels['kiro-claude']).toBe('Kiro Claude')
    expect(providersView).toContain('relayProtocolSelectLocked(draft.kind)')
    expect(setupWizardView).toContain('relayProtocolSelectLocked(draft.kind)')
    expect(providerKindLabelsZh['kiro-compatible']).toBe('Kiro Claude 中转')
    expect(setupWizardView).toContain('协议固定为 Kiro Claude')
  })

  it('keeps unverified Kiro relays out of bindable menus and all non-Claude client menus', () => {
    const unverified = kiroCollections(false)
    const unresolvedForMenu = resolveRouteSource('kiro-provider', unverified)
    expect(unresolvedForMenu).toBeDefined()
    expect(analyzeRouteSourceCompatibility('claude', unresolvedForMenu, unverified)).toMatchObject({
      eligible: false,
      mode: 'unsupported',
    })
    expect(listRouteSourcesForClient('claude', unverified)).toEqual([])

    const verified = kiroCollections(true)
    expect(listRouteSourcesForClient('claude', verified).map((source) => source.id)).toEqual(['kiro-provider'])
    for (const client of ['codex', 'gemini', 'grokbuild'] satisfies RouteClient[]) {
      expect(listRouteSourcesForClient(client, verified)).toEqual([])
    }

    expect(routesView).toContain('listRouteSourcesForClient(draft.client, snapshot)')
    expect(clientsView).toContain('listRouteSourcesForClient(activeClient, snapshot)')
    expect(clientsView).not.toContain('listRouteSources(snapshot)')
    expect(setupWizardView).toContain('setupEligibleAccounts')
    expect(setupWizardView).toContain('isKiroClaudeRouteSource(resolveRouteSource(provider.id, snapshot), snapshot)')
    expect(setupWizardView).toContain("selectedSourceIsKiroClaude && item !== 'claude'")
    expect(providersView).toContain("t('待工具验证', 'Tool verification required')")
    expect(providersView).toContain("provider.sourceType !== 'relay'")
    expect(providersView).toContain('eligibleAggregateMembers.map')
    expect(providersView).toContain('visibleAggregateMembers.length === 0')
    expect(providersView).toContain('Kiro Claude 中转尚未通过两轮工具链测试')
  })

  it('always lets an already-selected member escape after its verification becomes invalid', () => {
    const toggleBody = providersView.slice(
      providersView.indexOf('const toggleAggregateMember ='),
      providersView.indexOf('const submitAggregateRelay ='),
    )
    const selectedBranch = toggleBody.indexOf('if (memberSelected)')
    const eligibilityGate = toggleBody.indexOf('const candidateIssue = aggregateRelayCandidateIssue')

    expect(selectedBranch).toBeGreaterThanOrEqual(0)
    expect(eligibilityGate).toBeGreaterThan(selectedBranch)
    expect(toggleBody.slice(selectedBranch, eligibilityGate)).toContain('toggleAggregateRelayMember(current.members, account)')
    expect(toggleBody.slice(selectedBranch, eligibilityGate)).toContain('return')
    expect(providersView).toContain('Tool-chain verification expired; deselect this member and retest')
  })

  it('shows the native Event Stream bridge and states that tool results never trigger hidden Continue turns', () => {
    const path = 'Anthropic Messages → Kiro Claude → AWS Event Stream → Anthropic SSE'
    const chineseSafety = '不会把工具结果转换为 Continue 或占位文本'
    const englishSafety = 'Never converts tool results into Continue or placeholder text'

    expect(routesView).toContain(path)
    expect(routesView).toContain(chineseSafety)
    expect(routesView).toContain(englishSafety)
    expect(routesView.replace(chineseSafety, '').replace(englishSafety, '')).not.toMatch(/\bContinue\b/)
    expect(routesView).toContain('Manual 切换 Auto 后请新建会话；旧待确认调用不会自动重放')
  })
})

function kiroCollections(probed: boolean): {
  providers: ProviderDefinition[]
  accounts: Account[]
  pools: Pool[]
} {
  const provider: ProviderDefinition = {
    id: 'kiro-provider',
    name: 'Kiro Relay',
    sourceType: 'relay',
    kind: 'kiro-compatible',
    baseUrl: 'https://relay.example/generateAssistantResponse',
    protocol: 'kiro-claude',
    models: ['claude-sonnet'],
    toolRoundtripVerified: probed,
    capabilityProfile: probed ? {
      version: 1,
      origin: 'probed',
      checkedAt: 1_800_000_000_000,
      toolCalls: true,
    } : {
      version: 1,
      origin: 'inferred',
      toolCalls: true,
    },
    createdAt: 1,
    updatedAt: 1,
  }
  const account: Account = {
    id: 'kiro-account',
    providerId: provider.id,
    name: 'Kiro Key',
    credentialId: 'credential-1',
    maskedCredential: '****test',
    credentialType: 'api-key',
    status: 'active',
    priority: 1,
    weight: 1,
    maxConcurrency: 1,
    inFlight: 0,
    availableModels: ['claude-sonnet'],
    modelPolicy: 'all',
    modelAllowlist: [],
    circuitState: 'closed',
    consecutiveFailures: 0,
    createdAt: 1,
    updatedAt: 1,
  }
  return { providers: [provider], accounts: [account], pools: [] }
}
