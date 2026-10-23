import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const poolsView = readFileSync(
  new URL('../../src/renderer/src/views/PoolsView.tsx', import.meta.url),
  'utf8',
)
const styles = readFileSync(
  new URL('../../src/renderer/src/styles.css', import.meta.url),
  'utf8',
)

describe('Web WM pool eligibility panel', () => {
  it('runs the dedicated account verification API and listens for real stage progress', () => {
    expect(poolsView).toContain('api.verifyChatGptWebWmAccount(accountId, progressId)')
    expect(poolsView).toContain('api.onChatGptWebWmVerificationProgress')
    expect(poolsView).toContain('role="progressbar"')
    expect(poolsView).toContain("isChatGptWebWmAccountCandidate(account, provider)")
    expect(poolsView).toContain("t('待检测', 'Pending check')")
  })

  it('keeps the compact progress surface stable on desktop and narrow layouts', () => {
    expect(styles).toContain('.web-wm-verifier__progress')
    expect(styles).toContain('grid-template-columns: 29px minmax(0, 1fr) auto auto;')
    expect(styles).toContain('.web-wm-verifier__row { grid-template-columns: 29px minmax(0, 1fr) auto; }')
  })
})
