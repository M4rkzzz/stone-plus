import { describe, expect, it } from 'vitest'
import {
  AGENT_CAPABILITIES,
  AGENT_INSTALL_CHANNELS,
  AGENT_ROUTE_CLIENT,
  AGENT_TARGETS,
  agentCapabilities,
  agentRouteClient,
} from '../../src/shared/agent-lifecycle'

const expectedTargets = [
  'codex-desktop',
  'codex-cli',
  'claude-code',
  'claude-code-desktop',
  'claude-code-vsc',
  'gemini-cli',
  'grok-build',
  'deepseek-harness',
] as const

describe('agent lifecycle contract', () => {
  it('defines every supported target exactly once with a route and capabilities', () => {
    expect(AGENT_TARGETS).toEqual(expectedTargets)
    expect(new Set(AGENT_TARGETS).size).toBe(expectedTargets.length)
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
    for (const target of [
      'claude-code',
      'claude-code-desktop',
      'claude-code-vsc',
      'gemini-cli',
      'grok-build',
    ] as const) {
      expect(AGENT_CAPABILITIES[target]).toMatchObject({
        canRepairSessions: false,
        canRepairWorkspaceIndex: false,
      })
    }
  })

  it('keeps the legacy Claude CLI id and models Desktop and VSC as launch-only surfaces', () => {
    expect(AGENT_ROUTE_CLIENT['claude-code']).toBe('claude')
    expect(AGENT_ROUTE_CLIENT['claude-code-desktop']).toBe('claude')
    expect(AGENT_ROUTE_CLIENT['claude-code-vsc']).toBe('claude')

    expect(AGENT_CAPABILITIES['claude-code']).toMatchObject({
      canDetectRunning: true,
      canCloseKnownProcess: true,
      canRestart: true,
      sharedStateGroup: 'claude-home',
    })
    for (const target of ['claude-code-desktop', 'claude-code-vsc'] as const) {
      expect(AGENT_CAPABILITIES[target]).toMatchObject({
        canDetectRunning: false,
        canCloseKnownProcess: false,
        canLaunch: true,
        canRestoreConnection: true,
        canRestart: false,
        sharedStateGroup: 'claude-home',
      })
      expect(AGENT_CAPABILITIES[target].aggregateRestoreGroup).toBeUndefined()
    }
  })

  it('aliases only Codex aggregate restore while serializing all Claude configuration writes', () => {
    expect(AGENT_CAPABILITIES['codex-desktop'].aggregateRestoreGroup).toBe('codex-home')
    expect(AGENT_CAPABILITIES['codex-cli'].aggregateRestoreGroup).toBe('codex-home')
    for (const target of ['claude-code', 'claude-code-desktop', 'claude-code-vsc'] as const) {
      expect(AGENT_CAPABILITIES[target].sharedStateGroup).toBe('claude-home')
      expect(AGENT_CAPABILITIES[target].aggregateRestoreGroup).toBeUndefined()
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

  it('allows an already-running DeepSeek Harness workbench to be opened again', () => {
    expect(AGENT_CAPABILITIES['deepseek-harness']).toMatchObject({
      canDetectRunning: true,
      canLaunch: true,
      canOpenWhenRunning: true,
    })
  })

  it('keeps capability constants immutable at runtime', () => {
    expect(Object.isFrozen(AGENT_CAPABILITIES)).toBe(true)
    for (const target of AGENT_TARGETS) {
      expect(Object.isFrozen(AGENT_CAPABILITIES[target])).toBe(true)
    }
  })
})
