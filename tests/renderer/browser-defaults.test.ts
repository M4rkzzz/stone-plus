import { describe, expect, it } from 'vitest'
import {
  BUILTIN_BROWSER_DEFAULT_URL,
  resolveBuiltinBrowserShortcuts,
} from '../../src/renderer/src/browser-defaults'

describe('built-in browser defaults', () => {
  it('uses NVTokens as the fresh-install default favorite', () => {
    expect(resolveBuiltinBrowserShortcuts(null, true)).toEqual([{
      id: 'nvtokens-default',
      name: 'NVTokens',
      url: BUILTIN_BROWSER_DEFAULT_URL,
    }])
  })

  it('replaces the legacy AIProbe default while preserving custom favorites', () => {
    const stored = JSON.stringify([
      { id: 'aiprobe-default', name: 'AIProbe', url: 'https://aiprobe.top/' },
      { id: 'custom', name: 'Custom', url: 'https://example.com/' },
    ])

    expect(resolveBuiltinBrowserShortcuts(stored, true)).toEqual([
      { id: 'nvtokens-default', name: 'NVTokens', url: BUILTIN_BROWSER_DEFAULT_URL },
      { id: 'custom', name: 'Custom', url: 'https://example.com/' },
    ])
  })

  it('does not restore a default favorite the user removed after migration', () => {
    const stored = JSON.stringify([{ id: 'custom', name: 'Custom', url: 'https://example.com/' }])
    expect(resolveBuiltinBrowserShortcuts(stored, false)).toEqual([
      { id: 'custom', name: 'Custom', url: 'https://example.com/' },
    ])
  })
})
