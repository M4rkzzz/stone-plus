import type { RequestLog, RouteClient } from '@shared/types'
import { GPT_5_6_SOL_WM_MODEL } from '@shared/wm-routing'
import { requestLogSourceLabel } from './account-source-label'
import { accountDisplayName, conversationDisplayName } from './system-generated-text'

type RequestLogTranslator = (chinese: string, english: string) => string

export interface RequestLogSummary {
  successCount: number
  errorCount: number
  averageLatency: number
  averageFirstByte: number
  totalTokens: number
  hasStreaming: boolean
}

export function formatTokenBillions(totalTokens: number): string {
  const billions = Math.max(0, Number.isFinite(totalTokens) ? totalTokens : 0) / 1_000_000_000
  if (billions === 0) return '0b'
  const digits = billions >= 100 ? 0 : billions >= 10 ? 1 : billions >= 1 ? 2 : 3
  const formatted = billions.toFixed(digits)
  return `${digits ? formatted.replace(/\.?0+$/u, '') : formatted}b`
}

/** Web WM has a protocol-shell first byte; show its first meaningful output. */
export const displayedRequestFirstTokenMs = (log: RequestLog): number | undefined =>
  log.requestKind === 'compaction'
    ? undefined
    : log.upstreamModel === GPT_5_6_SOL_WM_MODEL
      ? log.firstTokenMs ?? log.accountFirstTokenMs ?? log.clientFirstWriteMs ?? log.upstreamFirstByteMs
      : log.upstreamFirstByteMs ?? log.firstTokenMs ?? log.clientFirstWriteMs

/** @deprecated Kept for renderer callers that still use the old helper name. */
export const displayedRequestFirstByteMs = displayedRequestFirstTokenMs

export function summarizeRequestLogs(logs: readonly RequestLog[]): RequestLogSummary {
  let successCount = 0
  let errorCount = 0
  let completedCount = 0
  let totalLatency = 0
  let firstByteCount = 0
  let totalFirstByte = 0
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
    const firstByte = displayedRequestFirstByteMs(log)
    if (firstByte !== undefined) {
      firstByteCount += 1
      totalFirstByte += firstByte
    }
    totalTokens += (log.inputTokens ?? 0) + (log.outputTokens ?? 0)
  }

  return {
    successCount,
    errorCount,
    averageLatency: completedCount ? Math.round(totalLatency / completedCount) : 0,
    averageFirstByte: firstByteCount ? Math.round(totalFirstByte / firstByteCount) : 0,
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
