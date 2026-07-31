import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FileRequestMonitorWindowStateStore,
  constrainRequestMonitorBounds,
  normalizeRequestMonitorWindowState,
  type RequestMonitorWindowState,
} from '../../src/main/request-monitor-window-state'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('request monitor window state', () => {
  it('normalizes untrusted persisted values and preserves only complete positions', () => {
    expect(normalizeRequestMonitorWindowState({
      isOpen: true,
      x: 12.4,
      y: 'bad',
      width: 10,
      height: 5_000,
      alwaysOnTop: false,
      opacity: 0.2,
    })).toEqual({
      isOpen: true,
      width: 180,
      height: 1_000,
      alwaysOnTop: false,
      opacity: 0.6,
    })
  })

  it('constrains restored bounds to the nearest visible work area', () => {
    const state: RequestMonitorWindowState = {
      isOpen: true,
      x: 4_000,
      y: -500,
      width: 500,
      height: 300,
      alwaysOnTop: true,
      opacity: 1,
    }

    expect(constrainRequestMonitorBounds(state, [
      { x: 0, y: 0, width: 1_920, height: 1_040 },
      { x: 1_920, y: 0, width: 1_280, height: 984 },
    ])).toEqual({ x: 2_700, y: 0, width: 500, height: 300 })
  })

  it('persists and reloads all monitor preferences across multiple saves', () => {
    const root = mkdtempSync(join(tmpdir(), 'stone-request-monitor-'))
    temporaryRoots.push(root)
    const store = new FileRequestMonitorWindowStateStore(join(root, 'request-monitor-window.json'))
    const first: RequestMonitorWindowState = {
      isOpen: true, x: 80, y: 90, width: 320, height: 210, alwaysOnTop: false, opacity: 0.8,
    }
    const second: RequestMonitorWindowState = {
      isOpen: false, x: 120, y: 140, width: 420, height: 280, alwaysOnTop: true, opacity: 0.6,
    }

    store.save(first)
    expect(store.load()).toEqual(first)
    store.save(second)
    expect(store.load()).toEqual(second)
  })
})
