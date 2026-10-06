import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(resolve(
  process.cwd(),
  'src/renderer/src/views/built-in-proxy/nodes-workspace.css',
), 'utf8')

describe('NodesWorkspace responsive CSS contract', () => {
  it('allows profile cards and node content to shrink without horizontal clipping', () => {
    expect(stylesheet).toContain('minmax(min(100%, 238px), 1fr)')
    expect(stylesheet).toMatch(/\.nodes-workspace\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/u)
    expect(stylesheet).toMatch(/\.nodes-workspace__table-wrap\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/u)
    expect(stylesheet).toMatch(/\.nodes-workspace__node-groups\s*\{[^}]*min-width:\s*0;/u)
  })

  it('stacks wide controls and reduces nested gutters at the 320px-safe breakpoint', () => {
    const narrowStart = stylesheet.indexOf('@media (max-width: 480px)')
    const narrowEnd = stylesheet.indexOf('@media (forced-colors: active)', narrowStart)
    expect(narrowStart).toBeGreaterThan(-1)
    expect(narrowEnd).toBeGreaterThan(narrowStart)
    const narrowRules = stylesheet.slice(narrowStart, narrowEnd)

    expect(narrowRules).toMatch(/\.nodes-workspace__section-heading\s*\{[^}]*flex-direction:\s*column;/u)
    expect(narrowRules).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(narrowRules).toContain('.nodes-workspace__nodes-heading > .button')
    expect(narrowRules).toContain('width: 100%')
    expect(narrowRules).toContain('.nodes-workspace__table td { min-width: 0; gap: 8px; }')
  })

  it('keeps keyboard focus visible for buttons, search, and sorting controls', () => {
    expect(stylesheet).toContain('.nodes-workspace :is(button, input, select):focus-visible')
    expect(stylesheet).toContain('outline: 2px solid var(--accent)')
    expect(stylesheet).toContain('.nodes-workspace__node-toolbar > label:first-child:focus-within')
    expect(stylesheet).toContain('@media (forced-colors: active)')
    expect(stylesheet).toContain('outline-color: Highlight')
  })
})
