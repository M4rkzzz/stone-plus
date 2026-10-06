import type { GatewaySettings } from '@shared/types'
import { translate, type UiLanguage } from './i18n'

export const SETTINGS_AUTOSAVE_DELAY_MS = 350

export function validateGatewayDraft(
  settings: GatewaySettings,
  language: UiLanguage,
): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!['127.0.0.1', '::1', 'localhost'].includes(settings.host.trim())) {
    errors.host = translate(language, '本地网关仅允许监听回环地址', 'The local gateway can only listen on a loopback address')
  }
  if (!Number.isSafeInteger(settings.port) || settings.port < 1024 || settings.port > 65535) {
    errors.port = translate(language, '端口范围为 1024–65535', 'Port must be between 1024 and 65535')
  }
  if (!Number.isSafeInteger(settings.requestTimeoutSeconds)
    || settings.requestTimeoutSeconds < 5
    || settings.requestTimeoutSeconds > 600) {
    errors.timeout = translate(language, '超时范围为 5–600 秒', 'Timeout must be between 5 and 600 seconds')
  }
  const backupRetention = settings.backupRetention ?? 10
  if (!Number.isSafeInteger(backupRetention) || backupRetention < 1 || backupRetention > 100) {
    errors.backupRetention = translate(language, '备份保留数量范围为 1–100', 'Backup retention must be between 1 and 100')
  }
  return errors
}

interface ScheduledValue<T> {
  revision: number
  value: T
}

/**
 * Debounces edits, permits only one persistence operation at a time, and only
 * publishes the result belonging to the most recent edit. An in-flight write
 * is not cancelled, but its stale completion can never overwrite newer UI.
 */
export class LatestAutosaveScheduler<T, TResult> {
  private revision = 0
  private pending?: ScheduledValue<T>
  private timer?: ReturnType<typeof setTimeout>
  private tail: Promise<void> = Promise.resolve()

  public constructor(private readonly options: {
    persist: (value: T) => Promise<TResult>
    onStart?: (value: T) => void
    onSuccess?: (result: TResult, value: T) => void
    onError?: (error: unknown, value: T) => void
  }) {}

  public schedule(value: T, delayMs = SETTINGS_AUTOSAVE_DELAY_MS): number {
    const scheduled = { revision: ++this.revision, value }
    this.pending = scheduled
    this.clearTimer()
    this.timer = setTimeout(() => {
      if (this.pending?.revision !== scheduled.revision) return
      this.pending = undefined
      this.timer = undefined
      void this.enqueue(scheduled)
    }, Math.max(0, delayMs))
    return scheduled.revision
  }

  /** Cancels a not-yet-started save and makes any in-flight result stale. */
  public invalidate(): void {
    this.revision += 1
    this.pending = undefined
    this.clearTimer()
  }

  /** Immediately queues the latest valid edit, used when leaving the page. */
  public flush(): Promise<void> {
    const scheduled = this.pending
    if (!scheduled) return this.tail
    this.pending = undefined
    this.clearTimer()
    return this.enqueue(scheduled)
  }

  private enqueue(scheduled: ScheduledValue<T>): Promise<void> {
    const task = this.tail
      .catch(() => undefined)
      .then(async () => {
        if (scheduled.revision !== this.revision) return
        this.options.onStart?.(scheduled.value)
        try {
          const result = await this.options.persist(scheduled.value)
          if (scheduled.revision === this.revision) {
            this.options.onSuccess?.(result, scheduled.value)
          }
        } catch (error) {
          if (scheduled.revision === this.revision) {
            this.options.onError?.(error, scheduled.value)
          }
        }
      })
    this.tail = task
    return task
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
