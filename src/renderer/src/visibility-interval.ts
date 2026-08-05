import { useEffect, useRef } from 'react'
import { useLowResourceMode } from './low-resource-mode'

export interface VisibilityIntervalEnvironment {
  isVisible(): boolean
  setTimer(callback: () => void, delayMs: number): VisibilityTimer
  clearTimer(timer: VisibilityTimer): void
  onVisibilityChange(listener: () => void): () => void
}

export type VisibilityTimer = number | ReturnType<typeof setTimeout>

export interface VisibilityIntervalOptions {
  runImmediately?: boolean
  environment?: VisibilityIntervalEnvironment
}

const browserEnvironment: VisibilityIntervalEnvironment = {
  isVisible: () => document.visibilityState !== 'hidden',
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (timer) => window.clearTimeout(timer as number),
  onVisibilityChange: (listener) => {
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
}

/**
 * Runs one non-overlapping recurring task only while the renderer is visible.
 * A timeout is scheduled after each completion instead of using setInterval,
 * so a slow IPC call cannot accumulate overlapping work.
 */
export function startVisibilityAwareInterval(
  callback: () => void | Promise<void>,
  intervalMs: number,
  options: VisibilityIntervalOptions = {},
): () => void {
  const environment = options.environment ?? browserEnvironment
  const delayMs = Number.isFinite(intervalMs) ? Math.max(50, Math.floor(intervalMs)) : 1_000
  let disposed = false
  let timer: VisibilityTimer | undefined
  let running = false

  const clearTimer = () => {
    if (timer === undefined) return
    environment.clearTimer(timer)
    timer = undefined
  }
  const schedule = () => {
    clearTimer()
    if (disposed || running || !environment.isVisible()) return
    timer = environment.setTimer(() => {
      timer = undefined
      run()
    }, delayMs)
  }
  const run = () => {
    if (disposed || running || !environment.isVisible()) return
    running = true
    void Promise.resolve()
      .then(callback)
      // Recurring refresh callbacks own their user-facing error state. Keep a
      // rejected refresh from terminating the scheduler or becoming unhandled.
      .catch(() => undefined)
      .finally(() => {
        running = false
        schedule()
      })
  }
  const visibilityChanged = () => {
    clearTimer()
    if (!environment.isVisible()) return
    if (options.runImmediately) run()
    else schedule()
  }
  const unsubscribe = environment.onVisibilityChange(visibilityChanged)
  if (options.runImmediately && environment.isVisible()) run()
  else schedule()

  return () => {
    disposed = true
    clearTimer()
    unsubscribe()
  }
}

export function useVisibilityAwareInterval(
  callback: () => void | Promise<void>,
  intervalMs: number,
  enabled = true,
  runImmediately = false,
  restartKey?: unknown,
  lowResourceMultiplier = 1,
): void {
  const { enabled: lowResourceMode } = useLowResourceMode()
  const callbackRef = useRef(callback)
  callbackRef.current = callback
  const effectiveIntervalMs = lowResourceMode
    ? intervalMs * Math.max(1, lowResourceMultiplier)
    : intervalMs

  useEffect(() => {
    if (!enabled) return undefined
    return startVisibilityAwareInterval(
      () => callbackRef.current(),
      effectiveIntervalMs,
      { runImmediately },
    )
  }, [effectiveIntervalMs, enabled, restartKey, runImmediately])
}
