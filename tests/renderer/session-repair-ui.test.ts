import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { CodexSessionRepairOverview, CodexSessionRepairPreview } from '../../src/shared/types'
import {
  cacheSessionRepairPreview,
  cachedOrAnalyzeSessionRepairPreview,
  isSessionRepairCancellation,
  repairSessionFromPreview,
  sessionRepairProgressPercent,
  summarizeSessionRepairChanges,
} from '../../src/renderer/src/session-repair-ui'

describe('session repair UI counts', () => {
  it('distinguishes discovered sessions from the subset that needs rewriting', () => {
    const overview = makeOverview(51)
    const preview = makePreview(overview, {
      rolloutFilesWithSessionMeta: 51,
      rolloutFilesAlreadyTargetProvider: 51,
      rolloutFilesToUpdate: 0,
    })

    expect(summarizeSessionRepairChanges(overview, preview)).toEqual({
      scannedSessionFiles: 51,
      parsedSessionFiles: 51,
      unrecognizedSessionFiles: 0,
      sessionFilesToUpdate: 0,
      synchronizedSessionFiles: 51,
      indexRowsToUpdate: 0,
      globalStateFieldsToUpdate: 0,
      totalChanges: 0,
      requiresRepair: false,
    })
  })

  it('enables repair when any session, index, or workspace field needs synchronization', () => {
    const overview = makeOverview(51)
    const preview = makePreview(overview, {
      rolloutFilesToUpdate: 2,
      rolloutFilesWithSessionMeta: 51,
      rolloutFilesAlreadyTargetProvider: 49,
      sqliteProviderRowsToUpdate: 3,
      sqliteUserEventRowsToUpdate: 4,
      sqliteCwdRowsToUpdate: 5,
      globalStateFieldsToUpdate: 1,
    })

    expect(summarizeSessionRepairChanges(overview, preview)).toMatchObject({
      scannedSessionFiles: 51,
      parsedSessionFiles: 51,
      unrecognizedSessionFiles: 0,
      sessionFilesToUpdate: 2,
      synchronizedSessionFiles: 49,
      indexRowsToUpdate: 12,
      globalStateFieldsToUpdate: 1,
      totalChanges: 15,
      requiresRepair: true,
    })
  })

  it('does not claim that repair is available before a preview exists', () => {
    expect(summarizeSessionRepairChanges(makeOverview(51), null)).toMatchObject({
      scannedSessionFiles: 51,
      parsedSessionFiles: 0,
      unrecognizedSessionFiles: 0,
      synchronizedSessionFiles: 0,
      totalChanges: 0,
      requiresRepair: false,
    })
  })

  it('reuses the same-revision preview and replaces it only when the revision changes', () => {
    const cache = new Map<string, CodexSessionRepairPreview>()
    const first = makePreview(makeOverview(51), {})
    const duplicate = structuredClone(first)
    const changed = { ...first, revision: 'b'.repeat(64) }

    expect(cacheSessionRepairPreview(cache, first)).toBe(first)
    expect(cacheSessionRepairPreview(cache, duplicate)).toBe(first)
    expect(cacheSessionRepairPreview(cache, changed)).toBe(changed)
    expect(cache.get('stone')).toBe(changed)
  })

  it('does not scan again when the selected provider already has a cached preview', async () => {
    const cache = new Map<string, CodexSessionRepairPreview>()
    const analyzed = makePreview(makeOverview(51), {})
    const analyze = vi.fn(async () => analyzed)

    const first = await cachedOrAnalyzeSessionRepairPreview(cache, 'stone', 'operation-1', analyze)
    const second = await cachedOrAnalyzeSessionRepairPreview(cache, 'stone', 'operation-2', analyze)

    expect(first).toBe(analyzed)
    expect(second).toBe(analyzed)
    expect(analyze).toHaveBeenCalledOnce()
    expect(analyze).toHaveBeenCalledWith('stone', 'operation-1')
  })

  it('repairs from the preview without a second revision-validation scan', async () => {
    const preview = makePreview(makeOverview(51), {})
    const repairCodexSessionsAndRestartChatGpt = vi.fn(async () => ({
      repair: {
        targetProvider: 'stone',
        repairedRolloutFiles: 0,
        sqliteProviderRowsUpdated: 0,
        sqliteUserEventRowsUpdated: 0,
        sqliteCwdRowsUpdated: 0,
        globalStateFieldsUpdated: 0,
        globalStateConflictingFields: [],
        skippedFiles: [],
        encryptedSessionFiles: 0,
        encryptedSourceProviders: [],
        backupPath: 'C:\\backups\\session-repair',
      },
      chatGptWasRunning: true,
      chatGptRestarted: true,
    }))

    await repairSessionFromPreview({ repairCodexSessionsAndRestartChatGpt }, preview, 'operation-3')

    expect(repairCodexSessionsAndRestartChatGpt).toHaveBeenCalledOnce()
    expect(repairCodexSessionsAndRestartChatGpt).toHaveBeenCalledWith('stone', undefined, 'operation-3')
  })

  it('presents bounded progress and recognizes safe cancellation errors', () => {
    expect(sessionRepairProgressPercent({ operationId: 'op', stage: 'scan', completed: 5, total: 20 })).toBe(25)
    expect(sessionRepairProgressPercent({ operationId: 'op', stage: 'discover', completed: 0 })).toBeUndefined()
    expect(sessionRepairProgressPercent({ operationId: 'op', stage: 'apply', completed: 30, total: 20 })).toBe(100)

    const aborted = new Error('Session repair cancelled.')
    aborted.name = 'AbortError'
    expect(isSessionRepairCancellation(aborted)).toBe(true)
    expect(isSessionRepairCancellation(new Error('disk failed'))).toBe(false)
  })

  it('binds progress and cancellation to the active operation instead of stale events', () => {
    const source = readFileSync(new URL('../../src/renderer/src/views/SessionRepairView.tsx', import.meta.url), 'utf8')
    expect(source).toContain('if (event.operationId === operationRef.current) setProgress(event)')
    expect(source).toContain('await api.cancelCodexSessionRepair(active)')
    expect(source).toContain('if (!active || cancelBusy) return')
    expect(source).toContain('disabled={running || !changeSummary.requiresRepair}')
  })
})

function makeOverview(sessionFiles: number): CodexSessionRepairOverview {
  return {
    codexHome: 'C:\\Users\\test\\.codex',
    currentProvider: 'stone',
    targets: [{ id: 'stone', sources: ['config', 'rollout', 'sqlite'], isCurrentProvider: true }],
    sessionFiles,
    archivedSessionFiles: 0,
    indexedThreads: sessionFiles,
    sqliteDatabases: ['state.sqlite'],
    skippedFiles: [],
  }
}

function makePreview(
  overview: CodexSessionRepairOverview,
  changes: Partial<CodexSessionRepairPreview>,
): CodexSessionRepairPreview {
  return {
    ...overview,
    targetProvider: 'stone',
    revision: 'a'.repeat(64),
    rolloutFilesToUpdate: 0,
    rolloutFilesWithSessionMeta: overview.sessionFiles + overview.archivedSessionFiles,
    rolloutFilesWithoutSessionMeta: 0,
    rolloutFilesAlreadyTargetProvider: overview.sessionFiles + overview.archivedSessionFiles,
    sqliteProviderRowsToUpdate: 0,
    sqliteUserEventRowsToUpdate: 0,
    sqliteCwdRowsToUpdate: 0,
    globalStateFieldsToUpdate: 0,
    globalStateConflictingFields: [],
    encryptedSessionFiles: 0,
    encryptedSourceProviders: [],
    ...changes,
  }
}
