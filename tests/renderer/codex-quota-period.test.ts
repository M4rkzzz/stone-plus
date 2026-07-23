import { describe, expect, it } from 'vitest'
import { codexLongQuotaPeriodLabel } from '../../src/renderer/src/codex-quota-period'

const DAY_SECONDS = 24 * 60 * 60

describe('Codex long quota period label', () => {
  it('labels an exact 30-day window as monthly', () => {
    expect(codexLongQuotaPeriodLabel(30 * DAY_SECONDS)).toBe('月')
  })

  it('tolerates small deviations around the upstream 30-day duration', () => {
    expect(codexLongQuotaPeriodLabel(30 * DAY_SECONDS - 12 * 60 * 60)).toBe('月')
    expect(codexLongQuotaPeriodLabel(30 * DAY_SECONDS + 12 * 60 * 60)).toBe('月')
  })

  it('keeps the weekly label for other or unknown durations', () => {
    expect(codexLongQuotaPeriodLabel(7 * DAY_SECONDS)).toBe('周')
    expect(codexLongQuotaPeriodLabel(29 * DAY_SECONDS)).toBe('周')
    expect(codexLongQuotaPeriodLabel(31 * DAY_SECONDS)).toBe('周')
    expect(codexLongQuotaPeriodLabel(undefined)).toBe('周')
  })
})
