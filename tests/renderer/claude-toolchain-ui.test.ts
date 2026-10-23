import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ProviderDefinition } from '../../src/shared/types'
import {
  anthropicRelayNeedsClaudeToolchainWarning,
  CLAUDE_TOOLCHAIN_UNVERIFIED_COPY,
  routeSourceNeedsClaudeToolchainWarning,
} from '../../src/renderer/src/claude-toolchain-ui'

const providersView = readFileSync(
  new URL('../../src/renderer/src/views/ProvidersView.tsx', import.meta.url),
  'utf8',
)
const routesView = readFileSync(
  new URL('../../src/renderer/src/views/RoutesView.tsx', import.meta.url),
  'utf8',
)

describe('Claude tool-chain advisory UI', () => {
  it('does not accept legacy generation probes as structured tool evidence', () => {
    const legacy = provider({
      capabilityProfile: {
        version: 1,
        origin: 'probed',
        checkedAt: 1_800_000_000_000,
        toolCalls: true,
      },
    })

    expect(anthropicRelayNeedsClaudeToolchainWarning(legacy)).toBe(true)
    expect(anthropicRelayNeedsClaudeToolchainWarning({ ...legacy, toolRoundtripVerified: false })).toBe(true)
    expect(anthropicRelayNeedsClaudeToolchainWarning({ ...legacy, toolRoundtripVerified: true })).toBe(false)
  })

  it('keeps official Anthropic and native Kiro sources outside this advisory', () => {
    expect(anthropicRelayNeedsClaudeToolchainWarning(provider({ sourceType: 'official-api', kind: 'anthropic' }))).toBe(false)
    expect(anthropicRelayNeedsClaudeToolchainWarning(provider({ kind: 'kiro-compatible', protocol: 'kiro-claude' }))).toBe(false)
  })

  it('warns when any enabled route-source member is an unverified Anthropic relay', () => {
    const unverified = provider({ id: 'relay-unverified' })
    const verified = provider({ id: 'relay-verified', toolRoundtripVerified: true })

    expect(routeSourceNeedsClaudeToolchainWarning({ accounts: [{ providerId: verified.id }] }, [verified])).toBe(false)
    expect(routeSourceNeedsClaudeToolchainWarning({ accounts: [{ providerId: verified.id }, { providerId: unverified.id }] }, [verified, unverified])).toBe(true)
  })

  it('shows the same warning on source cards and Claude route UI without blocking binding', () => {
    expect(CLAUDE_TOOLCHAIN_UNVERIFIED_COPY.zh).toBe('尚未通过 Claude 工具链验证，聊天可能可用但工具调用未确认')
    expect(providersView).toContain('CLAUDE_TOOLCHAIN_UNVERIFIED_COPY.zh')
    expect(routesView).toContain('CLAUDE_TOOLCHAIN_UNVERIFIED_COPY.zh')
    expect(providersView).toContain("t('测试 Claude 工具链', 'Test Claude tool chain')")
    expect(providersView).toContain("t('测试 Kiro 工具链', 'Test Kiro tool chain')")
    expect(routesView).toContain('const sourceAllowed = sourceCompatibility.eligible')
    expect(routesView).not.toContain('disabled={claudeToolchainUnverified}')
    expect(routesView).not.toContain('sourceCompatibility.eligible && !claudeToolchainUnverified')
  })
})

function provider(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    id: 'relay',
    name: 'Anthropic Relay',
    sourceType: 'relay',
    kind: 'anthropic-compatible',
    baseUrl: 'https://relay.example',
    protocol: 'anthropic-messages',
    models: ['claude-sonnet'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}
