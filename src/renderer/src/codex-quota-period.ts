const DAY_SECONDS = 24 * 60 * 60
const MONTH_WINDOW_SECONDS = 30 * DAY_SECONDS

// Keep the label stable when the upstream reports an approximately 30-day
// duration rather than the exact number of seconds.
const MONTH_WINDOW_TOLERANCE_SECONDS = 12 * 60 * 60

export function codexLongQuotaPeriodLabel(windowSeconds: number | undefined): '月' | '周' {
  if (windowSeconds === undefined || !Number.isFinite(windowSeconds)) return '周'
  return Math.abs(windowSeconds - MONTH_WINDOW_SECONDS) <= MONTH_WINDOW_TOLERANCE_SECONDS ? '月' : '周'
}
