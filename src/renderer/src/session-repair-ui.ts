import type {
  CodexSessionRepairOverview,
  CodexSessionRepairPreview,
  CodexSessionRepairProgressEvent,
  CodexSessionRepairRestartResult,
  GatewayApi,
} from '@shared/types'

export interface SessionRepairChangeSummary {
  scannedSessionFiles: number
  parsedSessionFiles: number
  unrecognizedSessionFiles: number
  sessionFilesToUpdate: number
  synchronizedSessionFiles: number
  indexRowsToUpdate: number
  globalStateFieldsToUpdate: number
  totalChanges: number
  requiresRepair: boolean
}

export function cacheSessionRepairPreview(
  cache: Map<string, CodexSessionRepairPreview>,
  preview: CodexSessionRepairPreview,
): CodexSessionRepairPreview {
  const cached = cache.get(preview.targetProvider)
  if (cached?.revision === preview.revision) return cached
  cache.set(preview.targetProvider, preview)
  return preview
}

export async function cachedOrAnalyzeSessionRepairPreview(
  cache: Map<string, CodexSessionRepairPreview>,
  targetProvider: string,
  operationId: string,
  analyze: (targetProvider: string, operationId: string) => Promise<CodexSessionRepairPreview>,
): Promise<CodexSessionRepairPreview> {
  const cached = cache.get(targetProvider)
  if (cached) return cached
  return cacheSessionRepairPreview(cache, await analyze(targetProvider, operationId))
}

export function repairSessionFromPreview(
  api: Pick<GatewayApi, 'repairCodexSessionsAndRestartChatGpt'>,
  preview: CodexSessionRepairPreview,
  operationId: string,
): Promise<CodexSessionRepairRestartResult> {
  // Intentionally omit expectedRevision. The restart boundary builds one fresh
  // post-shutdown plan, instead of scanning once to validate the renderer
  // preview and a second time to apply it.
  return api.repairCodexSessionsAndRestartChatGpt(preview.targetProvider, undefined, operationId)
}

export function sessionRepairProgressPercent(progress: CodexSessionRepairProgressEvent): number | undefined {
  if (progress.total === undefined || progress.total <= 0) return undefined
  return Math.max(0, Math.min(100, Math.round(progress.completed / progress.total * 100)))
}

export function isSessionRepairCancellation(cause: unknown): boolean {
  const message = cause instanceof Error
    ? `${cause.name} ${cause.message}`
    : typeof cause === 'string'
      ? cause
      : ''
  return /abort|cancel|取消/iu.test(message)
}

export function summarizeSessionRepairChanges(
  overview: CodexSessionRepairOverview | null,
  preview: CodexSessionRepairPreview | null,
): SessionRepairChangeSummary {
  const scannedSessionFiles = (overview?.sessionFiles ?? 0) + (overview?.archivedSessionFiles ?? 0)
  const sessionFilesToUpdate = preview?.rolloutFilesToUpdate ?? 0
  const indexRowsToUpdate = preview
    ? preview.sqliteProviderRowsToUpdate + preview.sqliteModelRowsToUpdate + preview.sqliteUserEventRowsToUpdate + preview.sqliteCwdRowsToUpdate
    : 0
  const globalStateFieldsToUpdate = preview?.globalStateFieldsToUpdate ?? 0
  const totalChanges = sessionFilesToUpdate + indexRowsToUpdate + globalStateFieldsToUpdate

  return {
    scannedSessionFiles,
    parsedSessionFiles: preview?.rolloutFilesWithSessionMeta ?? 0,
    unrecognizedSessionFiles: preview?.rolloutFilesWithoutSessionMeta ?? 0,
    sessionFilesToUpdate,
    synchronizedSessionFiles: preview?.rolloutFilesAlreadyTargetProvider ?? 0,
    indexRowsToUpdate,
    globalStateFieldsToUpdate,
    totalChanges,
    requiresRepair: preview !== null && totalChanges > 0,
  }
}
