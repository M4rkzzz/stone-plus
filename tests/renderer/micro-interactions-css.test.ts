import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

function ruleBodies(selector: string): string {
  const bodies: string[] = []
  const css = stylesheet.replace(/\/\*[\s\S]*?\*\//gu, '')
  for (const match of css.matchAll(/(?<selectors>[^{}]+)\{(?<body>[^{}]*)\}/gu)) {
    const selectors = match.groups?.selectors.split(',').map((candidate) => candidate.trim()) ?? []
    if (selectors.includes(selector)) bodies.push(match.groups?.body ?? '')
  }
  return bodies.join('\n')
}

describe('renderer micro-interaction CSS contract', () => {
  it('preserves the boot error horizontal centering throughout its entry animation', () => {
    const bootError = ruleBodies('.boot-error')
    const keyframe = stylesheet.match(/@keyframes ui-boot-error-in\s*\{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? ''

    expect(bootError).toContain('transform: translateX(-50%)')
    expect(bootError).toContain('animation: ui-boot-error-in')
    expect(keyframe).toContain('transform: translate(-50%, -6px)')
    expect(keyframe).toContain('transform: translateX(-50%)')
    expect(keyframe).not.toContain('transform: none')
  })

  it('does not animate high-frequency account progress widths', () => {
    const miniProgress = ruleBodies('.mini-progress span')

    expect(miniProgress).toContain('transition: none')
    expect(miniProgress).not.toMatch(/transition[^;]*width/u)
  })

  it('retains the global reduced-motion kill switch', () => {
    const start = stylesheet.lastIndexOf('@media (prefers-reduced-motion: reduce)')
    const end = stylesheet.indexOf('/* ============================================================', start)
    const reducedMotion = stylesheet.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(reducedMotion).toContain('transition-duration: 0.01ms !important')
    expect(reducedMotion).toContain('animation-duration: 0.01ms !important')
    expect(reducedMotion).toContain('animation-iteration-count: 1 !important')
  })
})
