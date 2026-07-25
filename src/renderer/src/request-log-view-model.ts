import type { RequestLog, RouteClient } from '@shared/types'
import { requestLogSourceLabel } from './account-source-label'
import { accountDisplayName, conversationDisplayName } from './system-generated-text'

type RequestLogTranslator = (chinese: string, english: string) => string

export interface RequestLogSummary {
  successCount: number
  errorCount: number
  averageLatency: number
  averageFirstToken: number
  totalTokens: number
  hasStreaming: boolean
}

export const displayedRequestFirstTokenMs = (log: RequestLog): number | undefined =>
  log.requestKind === 'compaction' ? undefined : log.upstreamFirstByteMs ?? log.firstTokenMs

export function summarizeRequestLogs(logs: readonly RequestLog[]): RequestLogSummary {
  let successCount = 0
  let errorCount = 0
  let completedCount = 0
  let totalLatency = 0
  let firstTokenCount = 0
  let totalFirstToken = 0
  let totalTokens = 0
  let hasStreaming = false

  for (const log of logs) {
    if (log.status === 'success') successCount += 1
    if (log.status === 'error') errorCount += 1
    if (log.status === 'streaming') {
      hasStreaming = true
    } else {
      completedCount += 1
      totalLatency += log.latencyMs
    }
    const firstToken = displayedRequestFirstTokenMs(log)
    if (firstToken !== undefined) {
      firstTokenCount += 1
      totalFirstToken += firstToken
    }
    totalTokens += (log.inputTokens ?? 0) + (log.outputTokens ?? 0)
  }

  return {
    successCount,
    errorCount,
    averageLatency: completedCount ? Math.round(totalLatency / completedCount) : 0,
    averageFirstToken: firstTokenCount ? Math.round(totalFirstToken / firstTokenCount) : 0,
    totalTokens,
    hasStreaming,
  }
}

export function filterRequestLogs(
  logs: RequestLog[],
  query: string,
  status: 'all' | RequestLog['status'],
  client: 'all' | RouteClient,
  accountCredentialTypes: ReadonlyMap<string, Parameters<typeof requestLogSourceLabel>[1]>,
  t: RequestLogTranslator,
): RequestLog[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized && status === 'all' && client === 'all') return logs
  return logs.filter((log) => {
    if (status !== 'all' && log.status !== status) return false
    if (client !== 'all' && log.client !== client) return false
    if (!normalized) return true
    return [
      log.id,
      log.model,
      log.upstreamModel,
      requestLogSourceLabel(log, accountCredentialTypes.get(log.accountId ?? '')),
      accountDisplayName(log.accountName, t),
      log.conversationId,
      conversationDisplayName(log.conversationName, t),
      log.error,
    ].some((value) => value?.toLowerCase().includes(normalized))
  })
}
