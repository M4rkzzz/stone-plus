import { describe, expect, it } from 'vitest'
import { normalizeRouteModelMap, resolveRouteModel } from '../../src/shared/route-models'

describe('route model mappings', () => {
  it('prefers an exact own mapping over the wildcard, then preserves the requested model', () => {
    expect(resolveRouteModel({ exact: 'upstream-exact', '*': 'upstream-default' }, 'exact'))
      .toBe('upstream-exact')
    expect(resolveRouteModel({ '*': 'upstream-default' }, 'another-model'))
      .toBe('upstream-default')
    expect(resolveRouteModel({}, 'unchanged-model')).toBe('unchanged-model')
  })

  it('never resolves inherited aliases or inherited wildcards', () => {
    const inheritedAlias = Object.create({ alias: 'inherited-target' }) as Record<string, string>
    const inheritedWildcard = Object.create({ '*': 'inherited-target' }) as Record<string, string>

    expect(resolveRouteModel(inheritedAlias, 'alias')).toBe('alias')
    expect(resolveRouteModel(inheritedWildcard, 'alias')).toBe('alias')
  })

  it('drops prototype-pollution keys and creates a null-prototype normalized map', () => {
    const input = JSON.parse('{"__proto__":"bad","constructor":"bad","prototype":"bad"," alias ":" target "," * ":" grok-4.20 "}') as unknown
    const normalized = normalizeRouteModelMap(input)

    expect(Object.getPrototypeOf(normalized)).toBeNull()
    expect(Object.hasOwn(normalized, '__proto__')).toBe(false)
    expect(Object.hasOwn(normalized, 'constructor')).toBe(false)
    expect(normalized).toEqual({ alias: 'target', '*': 'grok-4.20' })
    expect(resolveRouteModel(normalized, '__proto__')).toBe('grok-4.20')
  })

  it('ignores malformed exact values before using a valid wildcard', () => {
    const malformed = { exact: { nested: true }, '*': 'grok-4.20' } as unknown as Record<string, string>
    expect(resolveRouteModel(malformed, 'exact')).toBe('grok-4.20')
  })

  it('accepts the 256-character compatibility boundary and rejects longer or control-bearing mappings', () => {
    const maximum = 'm'.repeat(256)
    const oversized = 'm'.repeat(257)
    const normalized = normalizeRouteModelMap({
      [maximum]: maximum,
      [oversized]: 'target',
      oversizedTarget: oversized,
      ['control\u0000key']: 'target',
      controlTarget: 'target\nvalue',
      '*': 'grok-4.20',
    })

    expect(normalized[maximum]).toBe(maximum)
    expect(Object.hasOwn(normalized, oversized)).toBe(false)
    expect(Object.hasOwn(normalized, 'oversizedTarget')).toBe(false)
    expect(Object.hasOwn(normalized, 'control\u0000key')).toBe(false)
    expect(Object.hasOwn(normalized, 'controlTarget')).toBe(false)
    expect(resolveRouteModel(normalized, oversized)).toBe('grok-4.20')
  })
})
