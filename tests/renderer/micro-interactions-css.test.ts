import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

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
  it('uses one compact motion scale across shared UI feedback', () => {
    const root = ruleBodies(':root')

    expect(root).toContain('--motion-fast: 110ms')
    expect(root).toContain('--motion-base: 170ms')
    expect(root).toContain('--motion-slow: 230ms')
    expect(stylesheet).not.toMatch(/transition\s*:\s*all\b/u)
  })

  it('animates route changes without creating a transformed containing block', () => {
    const pageTransition = ruleBodies('.page-transition')
    const fadeKeyframe = stylesheet.match(/@keyframes ui-fade-in\s*\{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? ''

    expect(appSource).toContain('<div className="page-transition" key={page}>')
    expect(pageTransition).toContain('animation: ui-fade-in')
    expect(pageTransition).not.toContain('transform')
    expect(fadeKeyframe).not.toContain('transform')
  })

  it('gives navigation, gateway state, banners, and operation toasts restrained feedback', () => {
    const navIndicator = ruleBodies('.nav-item--active::before')
    const gatewayPulse = ruleBodies('.status-dot--pulse::after')
    const updateBanner = ruleBodies('.update-banner')
    const operationToast = ruleBodies('.operation-toast')

    expect(navIndicator).toContain('animation: ui-nav-indicator-in var(--motion-fast)')
    expect(gatewayPulse).toContain('animation: ui-status-pulse')
    expect(updateBanner).toContain('animation: ui-banner-in var(--motion-base)')
    expect(operationToast).toContain('animation: ui-toast-in var(--motion-base)')
  })

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

  it('turns decorative motion off in low-resource mode while retaining the functional spinner', () => {
    const start = stylesheet.indexOf('/* Low-resource mode is a renderer preference only.')
    const end = stylesheet.indexOf('.operation-center {', start)
    const lowResource = stylesheet.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(lowResource).toContain('html.low-resource-mode *::after')
    expect(lowResource).toContain('animation-duration: 1ms !important')
    expect(lowResource).toContain('transition-duration: 1ms !important')
    expect(lowResource).toContain('html.low-resource-mode .spin')
    expect(lowResource).toContain('animation-iteration-count: infinite !important')
  })
})
