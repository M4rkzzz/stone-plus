import { describe, expect, it } from 'vitest'
import {
  AGENT_CAPABILITIES,
  AGENT_INSTALL_CHANNELS,
  AGENT_ROUTE_CLIENT,
  AGENT_TARGETS,
  agentCapabilities,
  agentRouteClient,
} from '../../src/shared/agent-lifecycle'

describe('agent lifecycle contract', () => {
  it('defines every supported target exactly once with a route and capabilities', () => {
    expect(new Set(AGENT_TARGETS).size).toBe(5)
    expect(Object.keys(AGENT_CAPABILITIES).sort()).toEqual([...AGENT_TARGETS].sort())
    expect(Object.keys(AGENT_ROUTE_CLIENT).sort()).toEqual([...AGENT_TARGETS].sort())

    for (const target of AGENT_TARGETS) {
      expect(agentCapabilities(target)).toBe(AGENT_CAPABILITIES[target])
      expect(agentRouteClient(target)).toBe(AGENT_ROUTE_CLIENT[target])
    }
  })

  it('exposes only fixed official installation channels', () => {
    expect(AGENT_INSTALL_CHANNELS).toEqual(['recommended', 'preview'])
  })

  it('serializes Codex Desktop and CLI through their shared state group', () => {
    for (const target of ['codex-desktop', 'codex-cli'] as const) {
      expect(AGENT_CAPABILITIES[target]).toMatchObject({
        canRestoreConnection: true,
        canRepairSessions: true,
        canRepairWorkspaceIndex: true,
        canRestart: true,
        sharedStateGroup: 'codex-home',
      })
    }
    expect(AGENT_ROUTE_CLIENT['codex-desktop']).toBe('codex')
    expect(AGENT_ROUTE_CLIENT['codex-cli']).toBe('codex')
  })

  it('does not advertise conversation or workspace repair for Claude and Gemini', () => {
    for (const target of ['claude-code', 'gemini-cli', 'grok-build'] as const) {
      expect(AGENT_CAPABILITIES[target]).toMatchObject({
        canRestoreConnection: true,
        canRepairSessions: false,
        canRepairWorkspaceIndex: false,
      })
    }
  })

  it('maps Grok Build to its isolated route and state group', () => {
    expect(AGENT_ROUTE_CLIENT['grok-build']).toBe('grokbuild')
    expect(AGENT_CAPABILITIES['grok-build']).toMatchObject({
      canInstall: true,
      canRestart: true,
      sharedStateGroup: 'grok-home',
    })
  })

  it('keeps capability constants immutable at runtime', () => {
    expect(Object.isFrozen(AGENT_CAPABILITIES)).toBe(true)
    for (const target of AGENT_TARGETS) {
      expect(Object.isFrozen(AGENT_CAPABILITIES[target])).toBe(true)
    }
  })
})
