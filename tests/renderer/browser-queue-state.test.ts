import { describe, expect, it } from 'vitest'
import type { BrowserImportQueueState } from '../../src/shared/types'
import { newestBrowserQueueState } from '../../src/renderer/src/views/BrowserView'

function queue(revision: number, id: string): BrowserImportQueueState {
  return {
    revision,
    readyCount: 1,
    totalBytes: 1,
    items: [{
      id,
      fileName: `${id}.json`,
      sourceUrl: 'https://example.test/account.json',
      status: 'ready',
      sizeBytes: 1,
      receivedAt: 1,
    }],
  }
}

describe('browser import queue ordering', () => {
  it('does not let a late mutation response replace a newer pushed queue revision', () => {
    const pushed = queue(8, 'pushed')
    expect(newestBrowserQueueState(pushed, queue(7, 'late-response'))).toBe(pushed)
  })

  it('accepts equal or newer authoritative queue snapshots', () => {
    const current = queue(8, 'current')
    const equal = queue(8, 'equal')
    const newer = queue(9, 'newer')
    expect(newestBrowserQueueState(current, equal)).toBe(equal)
    expect(newestBrowserQueueState(current, newer)).toBe(newer)
  })
})
