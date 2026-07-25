import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const releaseWorkflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8')

describe('release workflow supply-chain policy', () => {
  it('pins every external GitHub Action to a full commit SHA', () => {
    const uses = [...releaseWorkflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1])

    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) {
      expect(action, `${action} must be immutable`).toMatch(/^[^/\s]+\/[^@\s]+@[0-9a-f]{40}$/)
    }
  })

  it('keeps the documented ad-hoc macOS baseline until notarization credentials are provisioned', () => {
    expect(releaseWorkflow).toContain('--config.mac.identity=-')
    expect(releaseWorkflow).toContain('--config.mac.hardenedRuntime=false')
    expect(releaseWorkflow).not.toContain('--config.mac.notarize=true')
    expect(releaseWorkflow).not.toContain('secrets.MAC_CSC_LINK')
    expect(releaseWorkflow).not.toContain('secrets.APPLE_APP_SPECIFIC_PASSWORD')
  })
})
