import { describe, expect, it } from 'vitest'
import {
  parseCodexToml,
  patchCodexTomlPaths,
} from '../../src/main/client-config/toml-format'

describe('nested Codex TOML patches', () => {
  it('updates section and dotted assignments while retaining comments and unknown neighbors', () => {
    const source = [
      'features.apps = false # dotted comment',
      'model = "gpt-existing"',
      '',
      '["windows"]',
      'sandbox = "unelevated" # section comment',
      'future = "keep"',
      '',
    ].join('\n')

    const result = patchCodexTomlPaths(source, [
      { path: ['features', 'apps'], value: true },
      { path: ['features', 'multi_agent'], value: true },
      { path: ['windows', 'sandbox'], value: 'elevated' },
      { path: ['agents', 'max_threads'], value: 8 },
    ])

    expect(parseCodexToml(result.content)).toMatchObject({
      model: 'gpt-existing',
      features: { apps: true, multi_agent: true },
      windows: { sandbox: 'elevated', future: 'keep' },
      agents: { max_threads: 8 },
    })
    expect(result.content).toContain('features.apps = true # dotted comment')
    expect(result.content).toContain('sandbox = "elevated" # section comment')
    expect(result.content).toContain('future = "keep"')
  })

  it('removes a nested value without disturbing its table or sibling values', () => {
    const source = [
      '[features]',
      'apps = true',
      'goals = true # keep',
      '',
    ].join('\n')

    const result = patchCodexTomlPaths(source, [
      { path: ['features', 'apps'], value: null },
    ])

    expect(parseCodexToml(result.content)).toEqual({ features: { goals: true } })
    expect(result.content).toContain('[features]')
    expect(result.content).toContain('goals = true # keep')
    expect(result.content).not.toContain('apps =')
  })
})
