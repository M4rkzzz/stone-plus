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

/**
 * Windows snapshot verification currently launches one bounded native read.
 * Five seconds keeps takeover drift visible without continuously spawning a
 * heavyweight registry reader. A successful check schedules the next one, so
 * slow checks never overlap or build an unbounded queue.
 */
const DEFAULT_ACTIVE_LEASE_MONITOR_INTERVAL_MS = 5_000

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

export type SystemProxyCompareResult = 'applied' | 'partial' | 'mismatch'

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
   * Confirms that the operating system still exposes the applied takeover.
   * Adapters which implement this must compare the effective native routing
   * fields, rather than trusting a successful setter process exit code.
   */
  isSnapshotApplied?(snapshot: SystemProxySnapshot): Promise<boolean>
  /**
   * Restores fields still owned by `expected` while preserving independently
   * changed native fields. `partial` means owned fields were restored while
   * one or more user-managed fields were preserved. `mismatch` is reserved
   * for the ownership marker itself being replaced, which means no Stone+
   * endpoint remains active.
   * Platform implementations should perform the ownership comparison and
   * native mutation in one platform command wherever the OS permits it.
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

/**
 * Deliberately contains only the public lease projection. Native snapshots,
 * PAC URLs and the user's previous proxy settings must never leave the lease.
 */
export interface SystemProxyLeaseEvent {
  type: 'unexpected-drift'
  state: SystemProxyLeaseState
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
  activeLeaseMonitorIntervalMs?: number
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
  private readonly activeLeaseMonitorIntervalMs: number
  private readonly listeners = new Set<(event: SystemProxyLeaseEvent) => void>()
  private operationTail: Promise<void> = Promise.resolve()
  private status: SystemProxyLeaseStatus = 'idle'
  private target?: NormalizedSystemProxyLeaseTarget
  private record?: SystemProxyLeaseRecoveryRecord
  private lastError?: { code: SystemProxyLeaseErrorCode; message: string }
  private activeLeaseMonitor?: ReturnType<typeof setTimeout>
  private activeLeaseMonitorEpoch = 0

  public constructor(options: SystemProxyLeaseOptions) {
    this.adapter = options.adapter
    this.recoveryStore = options.recoveryStore
    this.now = options.now ?? Date.now
    this.createLeaseId = options.createLeaseId ?? randomUUID
    this.activeLeaseMonitorIntervalMs = Math.max(
      1,
      options.activeLeaseMonitorIntervalMs ?? DEFAULT_ACTIVE_LEASE_MONITOR_INTERVAL_MS
    )
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

  public onEvent(listener: (event: SystemProxyLeaseEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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
        if (sameTarget(this.target, target)) {
          return this.verifyActiveExclusive(target)
        }
        throw this.fail(
          'lease_already_active',
          'Release the current system-proxy lease before changing the mixed endpoint.'
        )
      }

      const staleRecord = this.record ?? await this.loadRecoveryRecord()
      if (staleRecord) {
        this.stopActiveLeaseMonitor()
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
        if (
          this.adapter.isSnapshotApplied
          && !await this.adapter.isSnapshotApplied(applied)
        ) {
          throw new Error(
            'The operating system did not retain the Stone+ mixed proxy settings after applying them.'
          )
        }
      } catch (error) {
        // Keep both the in-memory and durable records. A partially applied
        // platform operation can then be restored by release() or next startup.
        throw this.fail(
          'apply_failed',
          applyFailureMessage(error),
          error
        )
      }
      this.status = 'active'
      return this.getState()
    })
  }

  /**
   * Performs a final, non-mutating ownership proof before a route generation is
   * published. On Windows the platform adapter reads the effective native
   * settings again; a stale in-memory `active` state is never sufficient.
   */
  public verifyActive(
    request: SystemProxyLeaseRequest,
    expectedLeaseId: string
  ): Promise<SystemProxyLeaseState> {
    return this.enqueue(() => this.verifyActiveExclusive(
      normalizeLeaseTarget(request),
      expectedLeaseId
    ))
  }

  /**
   * Starts periodic native ownership checks after the orchestrator has
   * atomically published this lease as the ready system-access owner.
   * Candidate acquisition and final verification deliberately do not arm the
   * timer: a pre-commit drift must abort/roll back, never trigger a second
   * acquisition over a user's newly selected proxy.
   */
  public startMonitoring(): void {
    if (!this.record) return
    this.startActiveLeaseMonitor(this.record.leaseId)
  }

  public release(): Promise<SystemProxyRestoreResult> {
    // Invalidate an already-fired callback before release joins the operation
    // queue. Its captured epoch/lease id can then never poison a later lease.
    this.stopActiveLeaseMonitor()
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
    this.stopActiveLeaseMonitor()
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
      if (result !== 'applied' && result !== 'partial' && result !== 'mismatch') {
        throw new Error(`Unsupported system-proxy compare result: ${String(result)}`)
      }
      // A mismatch means the user replaced Stone+'s ownership marker; partial
      // means independently changed fields were preserved. Both are terminal
      // safe outcomes, so the journal must not trigger a later overwrite.
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
    this.stopActiveLeaseMonitor()
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
    this.stopActiveLeaseMonitor()
    this.status = 'error'
    this.lastError = { code, message }
    return new SystemProxyLeaseError(code, message, cause === undefined ? undefined : { cause })
  }

  private async verifyActiveExclusive(
    target: NormalizedSystemProxyLeaseTarget,
    expectedLeaseId?: string
  ): Promise<SystemProxyLeaseState> {
    const record = this.record
    if (
      this.status !== 'active'
      || !record
      || !sameTarget(this.target, target)
      || (expectedLeaseId !== undefined && record.leaseId !== expectedLeaseId)
    ) {
      throw this.fail(
        'apply_failed',
        'The active Stone+ system-proxy lease no longer owns the expected mixed endpoint. '
        + 'Windows or another proxy application may have changed it.'
      )
    }

    try {
      if (
        !this.adapter.isSnapshotApplied
        || await this.adapter.isSnapshotApplied(record.applied)
      ) {
        return this.getState()
      }
    } catch (error) {
      throw this.fail(
        'apply_failed',
        'Could not verify the active Stone+ system-proxy lease. '
        + 'Windows or another proxy application may have changed it.',
        error
      )
    }
    throw this.fail(
      'apply_failed',
      'The operating-system proxy no longer points at the active Stone+ mixed endpoint. '
      + 'Windows or another proxy application may have changed it.'
    )
  }

  private startActiveLeaseMonitor(leaseId: string): void {
    if (!this.adapter.isSnapshotApplied || this.status !== 'active') return
    this.stopActiveLeaseMonitor()
    const epoch = this.activeLeaseMonitorEpoch
    const timer = setTimeout(() => {
      if (this.activeLeaseMonitor === timer) this.activeLeaseMonitor = undefined
      void this.enqueue(() => this.verifyActiveLeaseFromMonitor(leaseId, epoch)).catch(() => undefined)
    }, this.activeLeaseMonitorIntervalMs)
    timer.unref()
    this.activeLeaseMonitor = timer
  }

  private stopActiveLeaseMonitor(): void {
    this.activeLeaseMonitorEpoch += 1
    if (this.activeLeaseMonitor) clearTimeout(this.activeLeaseMonitor)
    this.activeLeaseMonitor = undefined
  }

  private async verifyActiveLeaseFromMonitor(leaseId: string, epoch: number): Promise<void> {
    if (!this.monitorStillOwnsLease(leaseId, epoch) || !this.adapter.isSnapshotApplied) return

    let applied: boolean
    let verificationFailure: unknown
    try {
      applied = await this.adapter.isSnapshotApplied(this.record!.applied)
    } catch (error) {
      applied = false
      verificationFailure = error
    }

    // release(), recovery, or a replacement can invalidate the monitor while
    // the native read is in flight. Never publish that stale result.
    if (!this.monitorStillOwnsLease(leaseId, epoch)) return
    if (applied) {
      this.startActiveLeaseMonitor(leaseId)
      return
    }

    const message = verificationFailure === undefined
      ? 'The operating-system proxy no longer points at the active Stone+ mixed endpoint. '
        + 'Windows or another proxy application changed it after takeover.'
      : 'The active Stone+ system-proxy lease could no longer be verified. '
        + 'Windows or another proxy application may have changed it after takeover.'
    this.fail('apply_failed', message, verificationFailure)
    this.emit({ type: 'unexpected-drift', state: this.getState() })
  }

  private monitorStillOwnsLease(leaseId: string, epoch: number): boolean {
    return this.activeLeaseMonitorEpoch === epoch
      && this.status === 'active'
      && this.record?.leaseId === leaseId
  }

  private emit(event: SystemProxyLeaseEvent): void {
    for (const listener of this.listeners) {
      try {
        listener({ type: event.type, state: cloneState(event.state) })
      } catch {
        // A lifecycle observer must not turn a detected OS drift into an
        // unhandled timer rejection or prevent other observers from reacting.
      }
    }
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

function cloneState(state: SystemProxyLeaseState): SystemProxyLeaseState {
  return {
    status: state.status,
    ...(state.target ? { target: cloneTarget(state.target) } : {}),
    ...(state.leaseId ? { leaseId: state.leaseId } : {}),
    recoveryPending: state.recoveryPending,
    ...(state.lastError ? { lastError: { ...state.lastError } } : {})
  }
}

function applyFailureMessage(error: unknown): string {
  const base = 'Could not apply the Stone+ mixed proxy to the operating system.'
  if (!(error instanceof Error)) return base
  if (
    /did not retain|changed the Stone\+ proxy value|WinINet rejected|safe system-proxy restore/i
      .test(error.message)
  ) {
    return `${base} Windows or another proxy application changed or rejected the settings before takeover could be confirmed.`
  }
  return base
}
