import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ApiSourceInput, SetupWizardStep } from '../../src/shared/types'
import {
  parseSetupSourceDraft,
  serializeSetupSourceDraft,
  setupWizardPhaseForStep,
  setupWizardPhases,
} from '../../src/renderer/src/setup-wizard-presentation'

const zh = <T>(chinese: T): T => chinese

describe('setup wizard presentation', () => {
  it('groups every resumable backend checkpoint into five user-facing phases', () => {
    const steps: SetupWizardStep[] = [
      'scan', 'source', 'source-config', 'network', 'upstream-test', 'client',
      'routing', 'gateway', 'verify', 'client-config', 'complete',
    ]
    expect(setupWizardPhases(zh).map((phase) => phase.id)).toEqual([
      'prepare', 'source', 'client', 'connect', 'complete',
    ])
    expect(steps.map(setupWizardPhaseForStep)).toEqual([
      'prepare', 'source', 'source', 'source', 'source', 'client',
      'connect', 'connect', 'connect', 'connect', 'complete',
    ])
  })

  it('restores non-sensitive source fields without caching credentials or probe evidence', () => {
    const draft: ApiSourceInput = {
      name: 'Example relay',
      sourceType: 'relay',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      protocol: 'openai-responses',
      credential: 'sk-never-cache-this',
      models: [' model-one '],
      defaultModel: 'model-one',
      priority: 4,
      weight: 7,
      maxConcurrency: 12,
      proxyId: 'proxy-one',
      capabilityProfile: { version: 1, origin: 'probed', nonStreaming: true },
      probeEvidenceToken: 'one-use-secret',
    }
    const serialized = serializeSetupSourceDraft(draft)
    expect(serialized).not.toContain('sk-never-cache-this')
    expect(serialized).not.toContain('one-use-secret')
    expect(serialized).not.toContain('capabilityProfile')
    expect(parseSetupSourceDraft(serialized)).toMatchObject({
      name: 'Example relay',
      baseUrl: 'http://127.0.0.1:8080/v1',
      credential: '',
      models: ['model-one'],
      proxyId: 'proxy-one',
    })
  })

  it('rejects invalid cached source types and protocols', () => {
    expect(parseSetupSourceDraft('{"sourceType":"oauth-system","kind":"openai","protocol":"openai-responses"}')).toBeNull()
    expect(parseSetupSourceDraft('{"sourceType":"relay","kind":"openai-compatible","protocol":"forged"}')).toBeNull()
  })

  it('never caches credentials accidentally embedded in an endpoint', () => {
    const serialized = serializeSetupSourceDraft({
      name: 'Unsafe draft', sourceType: 'relay', kind: 'custom',
      baseUrl: 'https://user:secret@example.test/v1?api_key=secret',
      protocol: 'openai-responses', credential: '', models: [],
      priority: 1, weight: 1, maxConcurrency: 1,
    })
    expect(serialized).not.toContain('secret')
    expect(parseSetupSourceDraft(serialized)?.baseUrl).toBe('')
  })

  it('keeps discard wording aligned with its safe route and pool rollback boundary', () => {
    const source = readFileSync(new URL('../../src/renderer/src/views/SetupWizardView.tsx', import.meta.url), 'utf8')
    expect(source).toContain('已导入账号和已保存的 API / 中转来源会保留')
    expect(source).toContain('本向导创建或修改的号池与路由会安全回滚')
    expect(source).not.toContain('回滚本次向导创建或修改的来源、号池和路由')
  })

  it('uses one automatic route, gateway, and real-request operation on the normal path', () => {
    const source = readFileSync(new URL('../../src/renderer/src/views/SetupWizardView.tsx', import.meta.url), 'utf8')
    expect(source).toContain("const result = await run('connect', async () =>")
    expect(source).toContain('const routingResult = await api.applySetupRouting')
    expect(source).toContain('const gatewayResult = await api.ensureGatewayRunning')
    expect(source).toContain('const verificationResult = await api.verifySetupRoute')
  })

  it('runs a real environment scan and makes the aggregate probe member explicit', () => {
    const source = readFileSync(new URL('../../src/renderer/src/views/SetupWizardView.tsx', import.meta.url), 'utf8')
    expect(source).toContain('api.runNetworkDiagnostics')
    expect(source).toContain('api.getClientConfigs()')
    expect(source).toContain('value={aggregateMemberId}')
    expect(source).toContain('最终端到端测试仍会经过聚合调度')
  })

  it('renders client brand glyphs inside a separate surface wrapper', () => {
    const source = readFileSync(new URL('../../src/renderer/src/views/SetupWizardView.tsx', import.meta.url), 'utf8')
    const styles = readFileSync(new URL('../../src/renderer/src/setup-wizard.css', import.meta.url), 'utf8')
    expect(source).toContain('icon={<img className={brand.iconClassName}')
    expect(styles).toContain('.setup-choice > span img')
  })

  it('uses lightweight directional and staggered motion without bypassing reduced-motion controls', () => {
    const source = readFileSync(new URL('../../src/renderer/src/views/SetupWizardView.tsx', import.meta.url), 'utf8')
    const styles = readFileSync(new URL('../../src/renderer/src/setup-wizard.css', import.meta.url), 'utf8')
    const globalStyles = readFileSync(new URL('../../src/renderer/src/styles.css', import.meta.url), 'utf8')
    expect(source).toContain('setup-wizard__stage--${stepMotionDirection}')
    expect(source).toContain('data-phase-index={currentPhaseIndex}')
    expect(styles).toContain('@keyframes setup-stage-forward')
    expect(styles).toContain('@keyframes setup-stage-backward')
    expect(styles).toContain('.setup-choice:nth-child(5)')
    expect(globalStyles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(globalStyles).toContain('html.low-resource-mode *')
  })
})
