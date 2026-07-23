import { randomUUID } from 'node:crypto'
import { isLoopbackHostname } from '../system-proxy'
import {
  parseSystemProxySnapshot,
  type SystemProxyLeaseRecoveryRecord,
  type SystemProxyLeaseRecoveryStore,
  type SystemProxySnapshot
} from './lease-recovery'

export type { SystemProxySnapshot } from './lease-recovery'

const DEFAULT_BYPASS_RULES = Object.freeze([
  '<local>',
  'localhost',
  '127.0.0.0/8',
  '::1'
])

export interface SystemProxyEndpoint {
  host: string
  port: number
}

export interface SystemProxyLeaseRequest {
  mixed: SystemProxyEndpoint
  /** Platform-independent rules which the adapter maps to its native format. */
  additionalBypassRules?: readonly string[]
}

export interface NormalizedSystemProxyLeaseTarget {
  mixed: SystemProxyEndpoint
  /** Chromium-compatible URL for the local sing-box mixed listener. */
  proxyUrl: string
  /** Always contains loopback exclusions to prevent PAC/mixed recursion. */
  bypassRules: readonly string[]
}

export type SystemProxyCompareResult = 'applied' | 'mismatch'

/**
 * Platform-specific mutations live behind this interface. A snapshot must be
 * complete and lossless. In particular, implementations must not reduce PAC
 * state to a boolean or discard the original bypass-rule representation.
 */
export interface SystemProxyPlatformAdapter {
  captureSnapshot(): Promise<SystemProxySnapshot>
  createMixedProxySnapshot(
    original: SystemProxySnapshot,
    target: NormalizedSystemProxyLeaseTarget
  ): Promise<SystemProxySnapshot> | SystemProxySnapshot
  applySnapshot(snapshot: SystemProxySnapshot): Promise<void>
  /**
   * Replaces `expected` with `replacement` only if every relevant native
   * setting is still equal. Returning mismatch protects changes made by the
   * user or another proxy application while Stone+ was running.
   */
  compareAndApplySnapshot(
    expected: SystemProxySnapshot,
    replacement: SystemProxySnapshot
  ): Promise<SystemProxyCompareResult>
}

export type SystemProxyLeaseStatus =
  | 'idle'
  | 'recovering'
  | 'acquiring'
  | 'active'
  | 'releasing'
  | 'error'

export type SystemProxyLeaseErrorCode =
  | 'invalid_mixed_endpoint'
  | 'lease_already_active'
  | 'snapshot_failed'
  | 'journal_failed'
  | 'apply_failed'
  | 'restore_failed'

export class SystemProxyLeaseError extends Error {
  public readonly code: SystemProxyLeaseErrorCode

  public constructor(code: SystemProxyLeaseErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SystemProxyLeaseError'
    this.code = code
  }
}

export interface SystemProxyLeaseState {
  status: SystemProxyLeaseStatus
  target?: NormalizedSystemProxyLeaseTarget
  leaseId?: string
  recoveryPending: boolean
  lastError?: { code: SystemProxyLeaseErrorCode; message: string }
}

export type SystemProxyRestoreStatus =
  | 'none'
  | 'restored'
  | 'preserved-user-settings'

export interface SystemProxyRestoreResult {
  status: SystemProxyRestoreStatus
  leaseId?: string
}

export interface SystemProxyLeaseOptions {
  adapter: SystemProxyPlatformAdapter
  recoveryStore: SystemProxyLeaseRecoveryStore
  now?: () => number
  createLeaseId?: () => string
}

/**
 * Owns the operating-system proxy only while the built-in proxy is active.
 * Every mutation is serialized so repeated clicks cannot interleave a restore
 * with a new acquisition. The durable journal makes an interrupted lease
 * repairable before the application's normal networking is initialized.
 */
export class SystemProxyLease {
  private readonly adapter: SystemProxyPlatformAdapter
  private readonly recoveryStore: SystemProxyLeaseRecoveryStore
  private readonly now: () => number
  private readonly createLeaseId: () => string
  private operationTail: Promise<void> = Promise.resolve()
  private status: SystemProxyLeaseStatus = 'idle'
  private target?: NormalizedSystemProxyLeaseTarget
  private record?: SystemProxyLeaseRecoveryRecord
  private lastError?: { code: SystemProxyLeaseErrorCode; message: string }

  public constructor(options: SystemProxyLeaseOptions) {
    this.adapter = options.adapter
    this.recoveryStore = options.recoveryStore
    this.now = options.now ?? Date.now
    this.createLeaseId = options.createLeaseId ?? randomUUID
  }

  public getState(): SystemProxyLeaseState {
    return {
      status: this.status,
      ...(this.target ? { target: cloneTarget(this.target) } : {}),
      ...(this.record ? { leaseId: this.record.leaseId } : {}),
      recoveryPending: Boolean(this.record),
      ...(this.lastError ? { lastError: { ...this.lastError } } : {})
    }
  }

  /**
   * Repairs a lease left by a prior process. Call this before constructing
   * sessions or issuing outbound requests; acquire() also invokes it as a
   * safety net when it finds a stale journal.
   */
  public recoverStaleLease(): Promise<SystemProxyRestoreResult> {
    return this.enqueue(() => this.recoverStaleLeaseExclusive())
  }

  public acquire(request: SystemProxyLeaseRequest): Promise<SystemProxyLeaseState> {
    return this.enqueue(async () => {
      const target = normalizeLeaseTarget(request)
      if (this.status === 'active' && this.record) {
        if (sameTarget(this.target, target)) return this.getState()
        throw this.fail(
          'lease_already_active',
          'Release the current system-proxy lease before changing the mixed endpoint.'
        )
      }

      const staleRecord = this.record ?? await this.loadRecoveryRecord()
      if (staleRecord) {
        this.record = staleRecord
        await this.restoreRecord(staleRecord, 'recovering')
      }

      this.status = 'acquiring'
      this.target = target
      this.lastError = undefined

      let original: SystemProxySnapshot
      let applied: SystemProxySnapshot
      try {
        original = parseSystemProxySnapshot(await this.adapter.captureSnapshot())
        applied = parseSystemProxySnapshot(
          await this.adapter.createMixedProxySnapshot(original, target)
        )
      } catch (error) {
        throw this.fail(
          'snapshot_failed',
          'Could not capture or prepare the operating-system proxy settings.',
          error
        )
      }

      const record: SystemProxyLeaseRecoveryRecord = {
        version: 1,
        leaseId: this.createLeaseId(),
        createdAt: this.now(),
        mixedProxyUrl: target.proxyUrl,
        original,
        applied
      }
      try {
        // The journal must reach disk before the system proxy points at Stone+.
        await this.recoveryStore.save(record)
      } catch (error) {
        throw this.fail(
          'journal_failed',
          'Could not persist the system-proxy crash recovery record.',
          error
        )
      }

      this.record = record
      try {
        await this.adapter.applySnapshot(applied)
      } catch (error) {
        // Keep both the in-memory and durable records. A partially applied
        // platform operation can then be restored by release() or next startup.
        throw this.fail(
          'apply_failed',
          'Could not apply the Stone+ mixed proxy to the operating system.',
          error
        )
      }
      this.status = 'active'
      return this.getState()
    })
  }

  public release(): Promise<SystemProxyRestoreResult> {
    return this.enqueue(async () => {
      const record = this.record ?? await this.loadRecoveryRecord()
      if (!record) {
        this.finishIdle()
        return { status: 'none' }
      }
      this.record = record
      return this.restoreRecord(record, 'releasing')
    })
  }

  /** A failed compare/restore leaves the journal intact, so release is retryable. */
  public retryRelease(): Promise<SystemProxyRestoreResult> {
    return this.release()
  }

  public async close(): Promise<void> {
    await this.release()
  }

  private async recoverStaleLeaseExclusive(): Promise<SystemProxyRestoreResult> {
    if (this.status === 'active') {
      throw this.fail(
        'lease_already_active',
        'Cannot recover a stale system-proxy lease while the current lease is active.'
      )
    }
    const record = this.record ?? await this.loadRecoveryRecord()
    if (!record) {
      this.finishIdle()
      return { status: 'none' }
    }
    this.record = record
    return this.restoreRecord(record, 'recovering')
  }

  private async restoreRecord(
    record: SystemProxyLeaseRecoveryRecord,
    transition: 'recovering' | 'releasing'
  ): Promise<SystemProxyRestoreResult> {
    this.status = transition
    this.lastError = undefined
    let result: SystemProxyCompareResult
    try {
      result = await this.adapter.compareAndApplySnapshot(record.applied, record.original)
      if (result !== 'applied' && result !== 'mismatch') {
        throw new Error(`Unsupported system-proxy compare result: ${String(result)}`)
      }
      // A mismatch means the user already replaced Stone+'s values. Clearing
      // the journal is safe and, crucially, does not overwrite those values.
      await this.recoveryStore.clear()
    } catch (error) {
      throw this.fail(
        'restore_failed',
        'Could not safely release the operating-system proxy lease; retry is available.',
        error
      )
    }
    const status: SystemProxyRestoreStatus = result === 'applied'
      ? 'restored'
      : 'preserved-user-settings'
    const leaseId = record.leaseId
    this.finishIdle()
    return { status, leaseId }
  }

  private async loadRecoveryRecord(): Promise<SystemProxyLeaseRecoveryRecord | undefined> {
    try {
      return await this.recoveryStore.load()
    } catch (error) {
      throw this.fail(
        'journal_failed',
        'Could not read the system-proxy crash recovery record.',
        error
      )
    }
  }

  private finishIdle(): void {
    this.status = 'idle'
    this.target = undefined
    this.record = undefined
    this.lastError = undefined
  }

  private fail(
    code: SystemProxyLeaseErrorCode,
    message: string,
    cause?: unknown
  ): SystemProxyLeaseError {
    this.status = 'error'
    this.lastError = { code, message }
    return new SystemProxyLeaseError(code, message, cause === undefined ? undefined : { cause })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

export function normalizeLeaseTarget(
  request: SystemProxyLeaseRequest
): NormalizedSystemProxyLeaseTarget {
  const host = normalizeHost(request.mixed.host)
  if (!isLoopbackHostname(host) || !validPort(request.mixed.port)) {
    throw new SystemProxyLeaseError(
      'invalid_mixed_endpoint',
      'The built-in mixed proxy must listen on a valid loopback endpoint.'
    )
  }
  const bypassRules: string[] = []
  const seen = new Set<string>()
  for (const rawRule of [...DEFAULT_BYPASS_RULES, ...(request.additionalBypassRules ?? [])]) {
    const rule = normalizeBypassRule(rawRule)
    const key = rule.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    bypassRules.push(rule)
  }
  const mixed = { host, port: request.mixed.port }
  return {
    mixed,
    proxyUrl: `http://${urlHost(host)}:${mixed.port}`,
    bypassRules
  }
}

function normalizeHost(value: string): string {
  return value.trim().replace(/^\[|\]$/g, '').toLowerCase()
}

function normalizeBypassRule(value: string): string {
  const rule = value.trim()
  if (!rule || rule.length > 512 || hasAsciiControlCharacter(rule)) {
    throw new SystemProxyLeaseError(
      'invalid_mixed_endpoint',
      'A system-proxy bypass rule is empty or invalid.'
    )
  }
  return rule
}

function hasAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535
}

function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

function sameTarget(
  left: NormalizedSystemProxyLeaseTarget | undefined,
  right: NormalizedSystemProxyLeaseTarget
): boolean {
  return Boolean(
    left
    && left.proxyUrl === right.proxyUrl
    && left.bypassRules.length === right.bypassRules.length
    && left.bypassRules.every((rule, index) => rule === right.bypassRules[index])
  )
}

function cloneTarget(target: NormalizedSystemProxyLeaseTarget): NormalizedSystemProxyLeaseTarget {
  return {
    mixed: { ...target.mixed },
    proxyUrl: target.proxyUrl,
    bypassRules: [...target.bypassRules]
  }
}
