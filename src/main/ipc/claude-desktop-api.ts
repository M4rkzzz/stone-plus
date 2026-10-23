import { ipcMain } from 'electron'
import type { ClaudeDesktopOfficialModeRestoreResult } from '@shared/types'
import { assertTrustedSender } from './trusted-sender'

const restoreOfficialModeChannel = 'stone:restore-claude-desktop-official-mode'

/**
 * Main-process dependency for the dedicated Claude Desktop restore boundary.
 * Production injects the process-wide operation coordinator; the IPC layer
 * deliberately strips its main-only rollback callback from the renderer result.
 */
export interface ClaudeDesktopOfficialModeRestorePort {
  restoreOfficial(): ClaudeDesktopOfficialModeRestoreResult | Promise<ClaudeDesktopOfficialModeRestoreResult>
}

export function registerClaudeDesktopApi(
  port: ClaudeDesktopOfficialModeRestorePort,
): () => Promise<void> {
  let disposeFlight: Promise<void> | undefined
  const acceptedOperations = new Set<Promise<unknown>>()

  ipcMain.handle(restoreOfficialModeChannel, (event, ...args: unknown[]) => {
    assertTrustedSender(event)
    if (args.length !== 0) {
      throw new Error('Claude Desktop official mode restore does not accept renderer arguments.')
    }
    return trackOperation(async () => rendererSafeResult(await port.restoreOfficial()))
  })

  return () => {
    if (disposeFlight) return disposeFlight
    ipcMain.removeHandler(restoreOfficialModeChannel)
    disposeFlight = Promise.allSettled([...acceptedOperations]).then(() => undefined)
    return disposeFlight
  }

  function trackOperation<T>(operation: () => T | Promise<T>): Promise<T> {
    const flight = Promise.resolve().then(operation)
    acceptedOperations.add(flight)
    void flight.then(
      () => acceptedOperations.delete(flight),
      () => acceptedOperations.delete(flight),
    )
    return flight
  }
}

function rendererSafeResult(value: unknown): ClaudeDesktopOfficialModeRestoreResult {
  if (typeof value !== 'object' || value === null || typeof (value as { changed?: unknown }).changed !== 'boolean') {
    throw new Error('Claude Desktop official mode restore returned an invalid result.')
  }
  return { changed: (value as { changed: boolean }).changed }
}
