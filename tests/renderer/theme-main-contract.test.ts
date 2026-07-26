import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('renderer to native theme contract', () => {
  const rendererTheme = source('src/renderer/src/theme.tsx')
  const preload = source('src/preload/index.ts')
  const gatewayApi = source('src/main/ipc/gateway-api.ts')
  const main = source('src/main/index.ts')

  it('carries both resolved colors and the user preference across IPC', () => {
    expect(rendererTheme).toContain('setUiTheme(theme, preference)')
    expect(preload).toContain("ipcRenderer.invoke('stone:set-ui-theme', theme, preference)")
    expect(gatewayApi).toContain("preference !== 'system' && preference !== 'light' && preference !== 'dark'")
    expect(gatewayApi).toContain('onUiThemeApplied?.(theme, preference)')
    expect(main).toContain('nativeTheme.themeSource = preference')
  })

  it('keeps the window hidden until renderer theme readiness with a bounded fallback', () => {
    expect(main).toContain('const RENDERER_THEME_READY_TIMEOUT_MS = 1_000')
    expect(main).toContain('if (!mainWindowReadyToShow || !rendererThemeReady) return')
    expect(main).toContain('rendererThemeReadyTimeout = setTimeout')
    expect(main).toContain('revealMainWindowIfReady()')
  })
})
