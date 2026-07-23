import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  AppSnapshot,
  BuiltInProxyProfileSummary,
  BuiltInProxyRuntimeState,
  GatewayApi,
} from '../../src/shared/types'
import {
  BUILT_IN_PROXY_WORKSPACE_TABS,
  parseBuiltInProxyWorkspacePreferences,
  parseBuiltInProxyWorkspaceTab,
  serializeBuiltInProxyWorkspacePreferences,
  summarizeBuiltInProxyImpact,
  summarizeBuiltInProxyRouteChain,
  summarizeBuiltInProxyRuntime,
  type BuiltInProxyWorkspaceTab,
} from '../../src/renderer/src/built-in-proxy-workspace'
import { I18nProvider } from '../../src/renderer/src/i18n'
import { BuiltInProxyView } from '../../src/renderer/src/views/BuiltInProxyView'
import { ProxyView } from '../../src/renderer/src/views/ProxyView'

describe('built-in proxy workspace preferences', () => {
  it('restores valid current and legacy tab preferences', () => {
    expect(parseBuiltInProxyWorkspacePreferences('activity')).toEqual({ version: 1, activeTab: 'activity' })
    expect(parseBuiltInProxyWorkspacePreferences(JSON.stringify({
      version: 1,
      activeTab: 'rules',
    }))).toEqual({ version: 1, activeTab: 'rules' })
    expect(serializeBuiltInProxyWorkspacePreferences({ activeTab: 'nodes' })).toBe(
      JSON.stringify({ version: 1, activeTab: 'nodes' }),
    )
  })

  it('falls back safely for corrupt, oversized, future-version, and unknown tab data', () => {
    for (const corrupt of [
      null,
      '',
      '{broken',
      'not-a-tab',
      'x'.repeat(4_097),
      '[]',
      JSON.stringify({ version: 2, activeTab: 'access' }),
      JSON.stringify({ version: 1, activeTab: '__proto__' }),
    ]) {
      expect(parseBuiltInProxyWorkspacePreferences(corrupt)).toEqual({ version: 1, activeTab: 'overview' })
    }
    expect(parseBuiltInProxyWorkspacePreferences('{broken', 'nodes')).toEqual({ version: 1, activeTab: 'nodes' })
    expect(parseBuiltInProxyWorkspaceTab(' activity ')).toBe('activity')
    expect(parseBuiltInProxyWorkspaceTab('unknown', 'profiles')).toBe('profiles')
  })

  it('uses the safe overview tab in the real view when persisted preferences are corrupt', () => {
    for (const corrupt of ['{broken', 'not-a-tab', JSON.stringify({ version: 2, activeTab: 'access' })]) {
      const html = renderWorkspace(runtime(), { persistedWorkspace: corrupt })
      expect(html).toContain('aria-labelledby="built-in-proxy-tab-overview"')
      expect(html).toContain('id="built-in-proxy-tab-overview" type="button" role="tab" aria-selected="true"')
      expect(html).toContain('Stone+ proxy overview')
      expect(html).not.toContain('Proxy settings</h2>')
    }
  })

  it('restores each of the six persisted workspace tabs in the real view', () => {
    const markers: Record<BuiltInProxyWorkspaceTab, string> = {
      overview: 'Stone+ proxy overview',
      profiles: 'Import another profile',
      nodes: 'Selected: Berlin',
      rules: 'Routing mode',
      access: 'Proxy settings',
      activity: 'Connections &amp; traffic',
    }
    for (const tab of BUILT_IN_PROXY_WORKSPACE_TABS) {
      const html = renderWorkspace(structuredClone(runtime()), { tab })
      expect(html).toContain(`aria-labelledby="built-in-proxy-tab-${tab}"`)
      expect(html).toContain(`id="built-in-proxy-tab-${tab}" type="button" role="tab" aria-selected="true"`)
      expect(html).toContain(markers[tab])
    }
  })
})

describe('built-in proxy workspace backend-truth projection', () => {
  it('shows takeover only after lifecycle, generation, route, endpoint, and access proof all match', () => {
    expect(summarizeBuiltInProxyRuntime(runtime())).toMatchObject({
      phase: 'ready',
      takeoverVerified: true,
      accessApplied: true,
      mixedPort: 3198,
    })

    const applying = runtime({
      accessState: { mode: 'system', status: 'applying', endpoint: 'http://127.0.0.1:4198' },
    })
    expect(summarizeBuiltInProxyRuntime(applying)).toMatchObject({
      phase: 'inconsistent', effectiveBuiltInRouteActive: true, takeoverVerified: false, accessApplied: false,
      effectiveMixedPort: 3198,
    })
    const retainedChain = summarizeBuiltInProxyRouteChain(applying)
    expect(retainedChain).toMatchObject({ kind: 'built-in', generation: 7, verified: true })
    expect(retainedChain.steps.slice(0, 2)).toEqual([
      { kind: 'stone' },
      { kind: 'mixed', endpoint: 'http://127.0.0.1:3198', port: 3198 },
    ])
    expect(JSON.stringify(retainedChain)).not.toContain('4198')

    expect(summarizeBuiltInProxyRuntime(runtime({ routeGeneration: 8 }))).toMatchObject({
      phase: 'inconsistent', generationConsistent: false, takeoverVerified: false,
    })
    expect(summarizeBuiltInProxyRuntime(runtime({
      effectiveRoute: { generation: 7, kind: 'built-in-tun', mixedPort: 3198, profileId: 'profile', nodeId: 'node-b' },
    }))).toMatchObject({ phase: 'inconsistent', takeoverVerified: false })
  })

  it('keeps system, TUN, and LAN settings independent in the projected route', () => {
    const systemLan = runtime({ settings: { ...runtime().settings, lanEnabled: true } })
    expect(summarizeBuiltInProxyImpact(systemLan)).toMatchObject({
      newStoneRequests: 'built-in-route',
      externalBindings: 'preserved-paused',
      accessMode: 'system',
      accessStatus: 'ready',
    })

    const tun = runtime({
      settings: { ...runtime().settings, accessMode: 'tun', lanEnabled: false },
      accessState: { mode: 'tun', status: 'ready', endpoint: 'http://127.0.0.1:3198', verifiedAt: 2 },
      effectiveRoute: { generation: 7, kind: 'built-in-tun', mixedPort: 3198, profileId: 'profile', nodeId: 'node-b' },
    })
    expect(summarizeBuiltInProxyRuntime(tun)).toMatchObject({
      phase: 'ready', accessMode: 'tun', takeoverVerified: true,
    })
    expect(summarizeBuiltInProxyRouteChain(tun).steps[1]).toEqual({
      kind: 'tun', mixedEndpoint: 'http://127.0.0.1:3198', mixedPort: 3198,
    })
  })

  it('reconstructs the selected node from persisted runtime state after a renderer restart', () => {
    const beforeRestart = runtime()
    const afterRestart = structuredClone(beforeRestart)

    expect(summarizeBuiltInProxyRuntime(afterRestart)).toMatchObject({
      activeProfileId: 'profile',
      selectedNodeId: 'node-b',
      selectedNodeName: 'Berlin',
      effectiveNodeId: 'node-b',
      effectiveNodeName: 'Berlin',
    })

    afterRestart.status = 'disabled'
    afterRestart.effectiveRoute = { generation: 8, kind: 'external', externalMode: 'system' }
    afterRestart.routeGeneration = 8
    afterRestart.accessState = { mode: 'system', status: 'idle' }
    expect(summarizeBuiltInProxyRuntime(afterRestart)).toMatchObject({
      phase: 'inactive', selectedNodeId: 'node-b', selectedNodeName: 'Berlin',
    })
    expect(summarizeBuiltInProxyRuntime(afterRestart).effectiveNodeId).toBeUndefined()
  })

  it('identifies generic custom rules as the active policy instead of a fixed scope preset', () => {
    const current = runtime()
    current.settings.customRules = {
      rules: [
        { id: 'domain', condition: 'domain-suffix', values: ['example.com'], action: 'proxy' },
        { id: 'cidr', condition: 'ip-cidr', values: ['10.0.0.0/8'], action: 'direct' },
        { id: 'ports', condition: 'port-range', values: ['8000:9000'], action: 'block' },
        { id: 'protocol', condition: 'protocol', values: ['http', 'tls'], action: 'proxy' },
      ],
      finalAction: 'direct',
    }

    expect(summarizeBuiltInProxyRouteChain(current).steps).toContainEqual({
      kind: 'policy', mode: 'rule', source: 'custom',
    })
  })
})

describe('built-in proxy workspace lifecycle, route, and candidate-state axes', () => {
  it('keeps first-start external routing distinct from a planned local endpoint', () => {
    const starting = runtime({
      status: 'starting',
      routeGeneration: 0,
      settings: { ...runtime().settings, hasEverActivated: false },
      effectiveRoute: { generation: 0, kind: 'external', externalMode: 'system' },
      accessState: { mode: 'system', status: 'applying', endpoint: 'http://127.0.0.1:4198' },
    })

    expect(summarizeBuiltInProxyRuntime(starting)).toMatchObject({
      phase: 'starting',
      takeoverVerified: false,
      accessApplied: false,
      effectiveBuiltInRouteActive: false,
      generationConsistent: true,
    })
    expect(summarizeBuiltInProxyRuntime(starting).effectiveMixedPort).toBeUndefined()
    expect(summarizeBuiltInProxyImpact(starting)).toMatchObject({
      newStoneRequests: 'transitioning',
      allNewStoneRequestsAffected: false,
      externalBindings: 'active',
      accessStatus: 'applying',
    })
    expect(summarizeBuiltInProxyRouteChain(starting)).toEqual({
      kind: 'external',
      generation: 0,
      verified: true,
      steps: [{ kind: 'stone' }, { kind: 'external', mode: 'system' }],
    })
    expect(JSON.stringify(summarizeBuiltInProxyRouteChain(starting))).not.toContain('4198')
  })

  it.each([
    ['starting', 'starting', 'transitioning', 'applying'],
    ['stopping', 'restoring', 'transitioning', 'applying'],
    ['error', 'failed', 'unconfirmed', 'error'],
  ] as const)(
    'keeps a retained built-in generation explicit while lifecycle is %s',
    (lifecycle, phase, requestImpact, accessStatus) => {
      const retained = runtime({
        status: lifecycle,
        accessState: {
          mode: 'system',
          status: accessStatus,
          endpoint: 'http://127.0.0.1:4198',
        },
        ...(lifecycle === 'error' ? {
          error: { category: 'system-proxy' as const, message: 'transition failed', retryable: true },
        } : {}),
      })

      expect(summarizeBuiltInProxyRuntime(retained)).toMatchObject({
        phase,
        effectiveBuiltInRouteActive: true,
        effectiveMixedPort: 3198,
        takeoverVerified: false,
        accessApplied: false,
      })
      expect(summarizeBuiltInProxyImpact(retained)).toMatchObject({
        newStoneRequests: requestImpact,
        allNewStoneRequestsAffected: true,
        externalBindings: 'preserved-paused',
      })
      const chain = summarizeBuiltInProxyRouteChain(retained)
      expect(chain).toMatchObject({ kind: 'built-in', generation: 7, verified: true })
      expect(chain.steps).toContainEqual({ kind: 'mixed', endpoint: 'http://127.0.0.1:3198', port: 3198 })
      expect(JSON.stringify(chain)).not.toContain('4198')
    },
  )

  it('treats blocked as terminal even when stale mixed metadata remains attached', () => {
    const blocked = runtime({
      status: 'error',
      routeGeneration: 8,
      effectiveRoute: {
        generation: 8,
        kind: 'blocked',
        mixedPort: 3198,
        profileId: 'profile',
        nodeId: 'node-b',
      },
      accessState: { mode: 'system', status: 'error', endpoint: 'http://127.0.0.1:3198' },
      error: { category: 'core-crashed', message: 'core exited', retryable: true },
    })

    expect(summarizeBuiltInProxyRuntime(blocked)).toMatchObject({
      phase: 'blocked',
      failClosed: true,
      effectiveBuiltInRouteActive: false,
      takeoverVerified: false,
    })
    expect(summarizeBuiltInProxyImpact(blocked)).toMatchObject({
      newStoneRequests: 'blocked',
      allNewStoneRequestsAffected: true,
      externalBindings: 'preserved-paused',
    })
    expect(summarizeBuiltInProxyRouteChain(blocked)).toEqual({
      kind: 'blocked',
      generation: 8,
      verified: true,
      steps: [{ kind: 'stone' }, { kind: 'blocked' }],
    })
  })

  it('never labels a retained route with candidate access or policy settings', () => {
    const candidateSettings = runtime({
      status: 'starting',
      settings: {
        ...runtime().settings,
        accessMode: 'tun',
        ruleMode: 'direct',
        customRules: {
          rules: [{ id: 'candidate', condition: 'domain-suffix', values: ['candidate.example'], action: 'block' }],
          finalAction: 'direct',
        },
      },
      // The effective generation is still the previously committed mixed route.
      effectiveRoute: {
        generation: 7,
        kind: 'built-in-mixed',
        mixedPort: 3198,
        profileId: 'profile',
        nodeId: 'node-b',
      },
      accessState: { mode: 'tun', status: 'applying', endpoint: 'http://127.0.0.1:4198' },
    })

    const summary = summarizeBuiltInProxyRuntime(candidateSettings)
    expect(summary).toMatchObject({
      phase: 'starting',
      effectiveBuiltInRouteActive: true,
      effectiveMixedPort: 3198,
      takeoverVerified: false,
      accessMode: 'tun',
      ruleMode: 'direct',
      selectedNodeId: 'node-b',
      selectedNodeName: 'Berlin',
      effectiveNodeId: 'node-b',
    })
    expect(summarizeBuiltInProxyRouteChain(candidateSettings)).toEqual({
      kind: 'built-in',
      generation: 7,
      verified: true,
      steps: [
        { kind: 'stone' },
        { kind: 'mixed', endpoint: 'http://127.0.0.1:3198', port: 3198 },
        {
          kind: 'node',
          role: 'selected-proxy-outbound',
          profileId: 'profile',
          nodeId: 'node-b',
          name: 'Berlin',
        },
      ],
    })
  })

  it('does not borrow a candidate profile when published route identity is absent or stale', () => {
    const candidateProfile = profile()
    candidateProfile.id = 'candidate-profile'
    candidateProfile.name = 'Candidate profile'
    candidateProfile.nodes = candidateProfile.nodes.map((node) => (
      node.id === 'node-b' ? { ...node, name: 'Candidate Berlin' } : node
    ))
    const missingPublishedProfile = runtime({
      profiles: [candidateProfile],
      settings: { ...runtime().settings, activeProfileId: 'candidate-profile' },
      effectiveRoute: {
        generation: 7,
        kind: 'built-in-mixed',
        mixedPort: 3198,
        profileId: 'missing-published-profile',
        nodeId: 'node-b',
      },
    })

    const summary = summarizeBuiltInProxyRuntime(missingPublishedProfile)
    expect(summary).toMatchObject({
      phase: 'ready',
      effectiveBuiltInRouteActive: true,
      takeoverVerified: true,
    })
    expect(summary.activeProfileName).toBeUndefined()
    expect(summary.selectedNodeName).toBeUndefined()
    expect(summary.effectiveNodeName).toBeUndefined()
    expect(summarizeBuiltInProxyRouteChain(missingPublishedProfile)).toEqual({
      kind: 'built-in',
      generation: 7,
      verified: true,
      steps: [
        { kind: 'stone' },
        { kind: 'mixed', endpoint: 'http://127.0.0.1:3198', port: 3198 },
        { kind: 'policy', mode: 'rule', source: 'unconfirmed' },
      ],
    })

    const html = renderWorkspace(missingPublishedProfile)
    const routeMarkup = markupBetween(html, 'Current route chain', 'Current selection')
    const selectionMarkup = markupBetween(html, 'Current selection', 'External settings')
    expect(routeMarkup).not.toContain('Candidate profile')
    expect(routeMarkup).not.toContain('Candidate Berlin')
    expect(selectionMarkup).not.toContain('Candidate profile')
    expect(selectionMarkup).not.toContain('Candidate Berlin')
  })
})

describe('built-in proxy workspace server-rendered guardrails', () => {
  it('separates first-profile guidance from a previously activated missing-profile failure', () => {
    const firstProfile = runtime({
      desiredEnabled: true,
      status: 'disabled',
      routeGeneration: 0,
      profiles: [],
      settings: {
        ...runtime().settings,
        activeProfileId: undefined,
        hasEverActivated: false,
      },
      effectiveRoute: { generation: 0, kind: 'external', externalMode: 'system' },
      accessState: { mode: 'system', status: 'idle' },
    })
    const firstHtml = renderWorkspace(firstProfile)
    expect(firstHtml).toContain('Not taking over yet')
    expect(firstHtml).toContain('Import your first valid profile')
    expect(firstHtml).toContain('Existing account/pool bindings and the saved system/direct route remain active')
    expect(firstHtml).not.toContain('Restore a valid profile')
    expect(firstHtml).not.toContain('role="tablist" aria-label="Proxy workspace"')

    const missingAfterActivation = runtime({
      desiredEnabled: true,
      status: 'error',
      routeGeneration: 8,
      profiles: [],
      settings: {
        ...runtime().settings,
        activeProfileId: undefined,
        hasEverActivated: true,
      },
      effectiveRoute: { generation: 8, kind: 'blocked', profileId: 'profile', nodeId: 'node-b' },
      accessState: { mode: 'system', status: 'error' },
      error: { category: 'configuration-invalid', message: 'No usable profile remains.', retryable: false },
    })
    const failedHtml = renderWorkspace(missingAfterActivation)
    expect(failedHtml).toContain('Fail-closed')
    expect(failedHtml).toContain('Restore a valid profile')
    expect(failedHtml).toContain('New Stone+ requests stay fail-closed')
    expect(failedHtml).toContain('No usable profile remains.')
    expect(failedHtml).not.toContain('Import your first valid profile')
    expect(failedHtml).not.toContain('role="tablist" aria-label="Proxy workspace"')
  })

  it('never renders the takeover label before the verified ready boundary', () => {
    const starting = runtime({
      status: 'starting',
      effectiveRoute: { generation: 7, kind: 'external', externalMode: 'system' },
      accessState: { mode: 'system', status: 'applying', endpoint: 'http://127.0.0.1:3198' },
    })
    const startingHtml = renderWorkspace(starting)
    expect(startingHtml).toContain('Starting')
    expect(startingHtml).toContain('Preparing')
    expect(startingHtml).toContain('Waiting to start')
    expect(startingHtml).not.toContain('Running (version unavailable)')
    expect(startingHtml).not.toContain('Taken over')
    expect(startingHtml).toContain('disabled=""')
    const startingAccessHtml = renderWorkspace(starting, { tab: 'access' })
    expect(startingAccessHtml).toMatch(/<fieldset[^>]*disabled=""/)
    expect(startingAccessHtml).toMatch(/type="checkbox"[^>]*disabled=""/)

    const readyHtml = renderWorkspace(runtime())
    expect(readyHtml).toContain('Taken over')
    expect(readyHtml).toContain('Running (version unavailable)')
    expect(readyHtml).not.toContain('Waiting to start')
  })

  it('keeps the published generation visible while a replacement is starting without calling the target access applied', () => {
    const replacing = runtime({
      status: 'starting',
      accessState: { mode: 'system', status: 'applying', endpoint: 'http://127.0.0.1:4198' },
    })
    const summary = summarizeBuiltInProxyRuntime(replacing)
    expect(summary).toMatchObject({
      phase: 'starting',
      effectiveBuiltInRouteActive: true,
      takeoverVerified: false,
      accessApplied: false,
      effectiveMixedPort: 3198,
    })

    const html = renderWorkspace(replacing)
    expect(html).toContain('Switching · route active')
    expect(html).toContain('published built-in route remains active until the atomic switch')
    expect(html).toContain('System proxy switching')
    expect(html).toContain('127.0.0.1:3198')
    expect(html).not.toContain('127.0.0.1:4198')
    expect(html).not.toContain('Taken over')

    const rulesHtml = renderWorkspace(replacing, { tab: 'rules' })
    expect(rulesHtml).toContain('Pending network policy')
    expect(rulesHtml).toContain('this target applies only after the candidate passes verification')
    expect(rulesHtml).not.toContain('Effective network policy')
  })

  it('keeps the published generation explicit during stopping and a failed restore', () => {
    const settings = { ...runtime().settings, desiredEnabled: false }
    const stopping = runtime({
      desiredEnabled: false,
      status: 'stopping',
      settings,
      accessState: { mode: 'system', status: 'applying', endpoint: 'http://127.0.0.1:3198' },
    })
    const stoppingHtml = renderWorkspace(stopping)
    expect(stoppingHtml).toContain('Restoring · route active')
    expect(stoppingHtml).toContain('current built-in generation remains active until completion')
    expect(stoppingHtml).toContain('127.0.0.1:3198')

    const failedRestore = runtime({
      desiredEnabled: false,
      status: 'error',
      settings,
      accessState: { mode: 'system', status: 'error', endpoint: 'http://127.0.0.1:3198' },
      error: { category: 'system-proxy', message: 'Could not restore the previous proxy.', retryable: true },
    })
    const failedHtml = renderWorkspace(failedRestore)
    expect(failedHtml).toContain('Operation failed · route active')
    expect(failedHtml).toContain('published built-in generation still serves Stone+ requests')
    expect(failedHtml).toContain('System proxy not ready')
    expect(failedHtml).toContain('127.0.0.1:3198')
    expect(failedHtml).not.toContain('This takeover was not applied')
  })

  it('never presents blocked route metadata as a live mixed endpoint', () => {
    const blocked = runtime({
      status: 'error',
      routeGeneration: 8,
      effectiveRoute: {
        generation: 8,
        kind: 'blocked',
        mixedPort: 3198,
        profileId: 'profile',
        nodeId: 'node-b',
      },
      accessState: { mode: 'system', status: 'error', endpoint: 'http://127.0.0.1:3198' },
      error: { category: 'core-crashed', message: 'The proxy core exited.', retryable: true },
    })
    expect(summarizeBuiltInProxyRuntime(blocked)).toMatchObject({
      phase: 'blocked', effectiveBuiltInRouteActive: false, takeoverVerified: false, failClosed: true,
    })
    const html = renderWorkspace(blocked)
    expect(html).toContain('Error / blocked')
    expect(html).toContain('Fail-closed')
    expect(html).not.toContain('127.0.0.1:3198')
    expect(html).not.toContain('Taken over')
  })

  it('keeps candidate node and rule choices out of the retained published route chain', () => {
    const candidateProfile = profile()
    candidateProfile.activeNodeId = 'node-a'
    const replacing = runtime({
      status: 'starting',
      profiles: [candidateProfile],
      settings: { ...runtime().settings, ruleMode: 'global', accessMode: 'tun' },
      accessState: { mode: 'tun', status: 'applying', endpoint: 'http://127.0.0.1:4198' },
    })

    const retainedChain = summarizeBuiltInProxyRouteChain(replacing)
    expect(retainedChain).toMatchObject({ kind: 'built-in', generation: 7, verified: true })
    expect(retainedChain.steps).toEqual([
      { kind: 'stone' },
      { kind: 'mixed', endpoint: 'http://127.0.0.1:3198', port: 3198 },
      {
        kind: 'node',
        role: 'selected-proxy-outbound',
        profileId: 'profile',
        nodeId: 'node-b',
        name: 'Berlin',
      },
    ])
    expect(JSON.stringify(retainedChain)).not.toContain('Amsterdam')
    expect(JSON.stringify(retainedChain)).not.toContain('global')

    const html = renderWorkspace(replacing)
    const routeMarkup = markupBetween(html, 'Current route chain', 'Current selection')
    expect(routeMarkup).toContain('Berlin')
    expect(routeMarkup).toContain('127.0.0.1:3198')
    expect(routeMarkup).not.toContain('Amsterdam')
    expect(routeMarkup).not.toContain('Global')
    expect(routeMarkup).not.toContain('127.0.0.1:4198')

    const selectionMarkup = markupBetween(html, 'Current selection', 'External settings')
    expect(selectionMarkup).toContain('Berlin')
    expect(selectionMarkup).toContain('Current generation policy is not captured')
    expect(selectionMarkup).toContain('System proxy')
    expect(selectionMarkup).not.toContain('Amsterdam')
    expect(selectionMarkup).not.toContain('Global')
    expect(selectionMarkup).not.toContain('TUN')
  })

  it('keeps access errors independent from a retained healthy route generation', () => {
    const failedSwitch = runtime({
      status: 'error',
      accessState: { mode: 'system', status: 'error', endpoint: 'http://127.0.0.1:4198' },
      error: { category: 'system-proxy', message: 'Candidate access verification failed.', retryable: true },
    })

    const html = renderWorkspace(failedSwitch)
    expect(html).toContain('Operation failed · route active')
    expect(html).toContain('System proxy not ready')
    expect(html).toContain('Route active')
    expect(html).toContain('127.0.0.1:3198')
    expect(html).toContain('Route generation</dt><dd>#7</dd>')
    expect(html).not.toContain('127.0.0.1:4198')
    expect(html).not.toContain('Taken over')
  })

  it('renders distinct system, TUN, and LAN state without coupling their selections', () => {
    const systemHtml = renderWorkspace(runtime(), { tab: 'access' })
    expect(systemHtml).toContain('System proxy target')
    expect(systemHtml).toContain('Local-only access is active')
    expect(systemHtml).toContain('The mixed endpoint listens on local loopback only')

    const tun = runtime({
      settings: { ...runtime().settings, accessMode: 'tun', lanEnabled: true },
      effectiveRoute: { generation: 7, kind: 'built-in-tun', mixedPort: 3198, profileId: 'profile', nodeId: 'node-b' },
      accessState: { mode: 'tun', status: 'ready', endpoint: 'http://127.0.0.1:3198', verifiedAt: 2 },
    })
    const tunHtml = renderWorkspace(tun, { tab: 'access' })
    expect(tunHtml).toContain('TUN upstream')
    expect(tunHtml).toContain('0.0.0.0:3198')
    expect(tunHtml).toContain('LAN access is active')
    expect(tunHtml).toContain('Devices on the same network may reach the mixed endpoint without additional authentication')
  })

  it('renders the generic ordered rule editor and never the rejected fixed custom-scope design', () => {
    const current = runtime()
    current.settings.customRules = {
      rules: [{ id: 'domain', condition: 'domain', values: ['api.example.com'], action: 'proxy' }],
      finalAction: 'direct',
    }
    const html = renderWorkspace(current, { tab: 'rules' })

    for (const label of [
      'Exact domain',
      'Domain suffix',
      'IP / CIDR',
      'Port range',
      'Network',
      'Application protocol',
      'Private network',
      'Mainland China',
    ]) expect(html).toContain(label)
    expect(html).toContain('Custom rules are a global setting shared by every profile')
    expect(html).toContain('Unmatched traffic')
    expect(html).not.toContain('Custom scope')
    expect(html).not.toContain('自定义范围')
  })

  it('restores the selected node and group when the renderer starts again', () => {
    const options: RenderWorkspaceOptions = {
      tab: 'nodes',
      persistedNodePanel: JSON.stringify({ collapsed: false, groupFilters: { profile: 'Europe' } }),
    }
    const beforeRestart = renderWorkspace(runtime(), options)
    const afterRestart = renderWorkspace(structuredClone(runtime()), options)

    for (const html of [beforeRestart, afterRestart]) {
      expect(html).toContain('Selected: Berlin · Europe')
      expect(html).toContain('aria-pressed="true" class="is-active">Europe')
      expect(html).toContain('Berlin')
      expect(html).toContain('Selected</button>')
    }
  })

  it('wires preserved outbound mode and actual external binding counts from the app snapshot', () => {
    const html = renderProxyPage({
      builtInProxyRuntimeState: runtime(),
      gateway: { outboundNetworkMode: 'system' },
      accounts: [
        { id: 'account-bound-a', proxyId: 'proxy-a' },
        { id: 'account-unbound' },
        { id: 'account-bound-b', proxyId: 'proxy-b' },
      ],
      pools: [
        { id: 'pool-bound', proxyId: 'proxy-c' },
        { id: 'pool-unbound' },
      ],
    } as unknown as AppSnapshot)

    expect(html).toContain('2 accounts · 1 pool')
    expect(html).toContain('Retained, paused')
    expect(html).toContain('outboundNetworkMode</span><strong>System proxy</strong>')
    expect(html).toContain('Original retained')
    expect(html).not.toContain('3 accounts')
    expect(html).not.toContain('2 pools')
  })
})

function runtime(overrides: Partial<BuiltInProxyRuntimeState> = {}): BuiltInProxyRuntimeState {
  const base: BuiltInProxyRuntimeState = {
    desiredEnabled: true,
    status: 'ready',
    routeGeneration: 7,
    settings: {
      desiredEnabled: true,
      activeProfileId: 'profile',
      accessMode: 'system',
      ruleMode: 'rule',
      mixedPort: 3198,
      lanEnabled: false,
      autoStart: true,
      hasEverActivated: true,
      updatedAt: 1,
    },
    profiles: [profile()],
    effectiveRoute: {
      generation: 7,
      kind: 'built-in-mixed',
      mixedPort: 3198,
      profileId: 'profile',
      nodeId: 'node-b',
    },
    accessState: {
      mode: 'system',
      status: 'ready',
      endpoint: 'http://127.0.0.1:3198',
      verifiedAt: 2,
    },
  }
  return { ...base, ...overrides }
}

function profile(): BuiltInProxyProfileSummary {
  return {
    id: 'profile',
    name: 'Daily profile',
    source: 'import',
    format: 'uri-list',
    nodes: [
      { id: 'node-a', name: 'Amsterdam', type: 'socks', groupIds: ['Europe'], latencyStatus: 'available', latencyMs: 35 },
      { id: 'node-b', name: 'Berlin', type: 'vless', groupIds: ['Europe'], latencyStatus: 'available', latencyMs: 42 },
    ],
    nodeCount: 2,
    groupCount: 1,
    ruleStatus: 'preserved',
    activeNodeId: 'node-b',
    createdAt: 1,
    updatedAt: 2,
  }
}

interface RenderWorkspaceOptions {
  tab?: BuiltInProxyWorkspaceTab
  persistedWorkspace?: string | null
  persistedNodePanel?: string | null
}

function renderWorkspace(
  state: BuiltInProxyRuntimeState,
  options: RenderWorkspaceOptions = {},
): string {
  const persistedWorkspace = options.persistedWorkspace
    ?? serializeBuiltInProxyWorkspacePreferences({ activeTab: options.tab ?? 'overview' })
  vi.stubGlobal('navigator', { language: 'en-US' })
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => {
        if (key === 'stone.built-in-proxy.workspace.v1') return persistedWorkspace
        if (key === 'stone.built-in-proxy.node-panel.v1') return options.persistedNodePanel ?? null
        return null
      },
      setItem: () => undefined,
    },
  })
  try {
    return renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(BuiltInProxyView, {
        api: {} as GatewayApi,
        initialState: state,
      }),
    ))
  } finally {
    vi.unstubAllGlobals()
  }
}

function renderProxyPage(snapshot: AppSnapshot): string {
  vi.stubGlobal('navigator', { language: 'en-US' })
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => key === 'stone.built-in-proxy.workspace.v1'
        ? serializeBuiltInProxyWorkspacePreferences({ activeTab: 'overview' })
        : null,
      setItem: () => undefined,
    },
  })
  try {
    return renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(ProxyView, {
        snapshot,
        api: {} as GatewayApi,
        runAction: async () => false,
        busyKeys: new Set<string>(),
      }),
    ))
  } finally {
    vi.unstubAllGlobals()
  }
}

function markupBetween(html: string, start: string, end: string): string {
  const startIndex = html.indexOf(start)
  const endIndex = html.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return html.slice(startIndex, endIndex)
}
