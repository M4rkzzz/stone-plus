import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('overview readiness panel', () => {
  it('defaults to a compact persisted summary and separates expanded detail regions', () => {
    const source = readFileSync(new URL('../../src/renderer/src/readiness-panel.tsx', import.meta.url), 'utf8')
    const styles = readFileSync(new URL('../../src/renderer/src/styles.css', import.meta.url), 'utf8')

    expect(source).toContain("READINESS_PANEL_EXPANDED_STORAGE_KEY")
    expect(source).toContain('aria-expanded={expanded}')
    expect(source).toContain('hidden={!expanded}')
    expect(source).toContain("warningCount")
    expect(source).toContain("链路状态")
    expect(source).toContain("建议操作")
    expect(styles).toContain('.readiness-panel__region + .readiness-panel__region')
    expect(styles).toContain('.readiness-panel__details[hidden]')
  })
})
