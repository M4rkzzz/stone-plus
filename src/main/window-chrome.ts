import type { BrowserWindow } from 'electron'
import type { UiTheme } from '@shared/types'

interface WindowChromePalette {
  /** Paints the frame before the renderer's first paint, so startup shows no flash. */
  background: string
  /**
   * Keep the native Windows overlay opaque. A transparent overlay makes DWM
   * blend the continuously updating renderer behind the caption buttons, which
   * can stall desktop composition under request bursts.
   */
  titleBar: string
  titleBarSymbol: string
}

const CHROME_PALETTES: Record<UiTheme, WindowChromePalette> = {
  light: { background: '#f9fbfa', titleBar: '#f9fbfa', titleBarSymbol: '#3d4a45' },
  dark: { background: '#161c1a', titleBar: '#161c1a', titleBarSymbol: '#bcc7c2' },
}

export const TITLE_BAR_HEIGHT = 38

export function windowChromePalette(theme: UiTheme): WindowChromePalette {
  return CHROME_PALETTES[theme]
}

/**
 * Repaints the frame and native caption buttons so they match the renderer's
 * theme. macOS derives its inset title bar from the window background, so only
 * the overlay update is platform-gated.
 */
export function applyWindowChromeTheme(window: BrowserWindow | null, theme: UiTheme): void {
  if (!window || window.isDestroyed()) return
  const palette = windowChromePalette(theme)
  window.setBackgroundColor(palette.background)
  if (process.platform === 'darwin') return
  try {
    window.setTitleBarOverlay({
      color: palette.titleBar,
      symbolColor: palette.titleBarSymbol,
      height: TITLE_BAR_HEIGHT,
    })
  } catch {
    // setTitleBarOverlay throws when the window was created without an overlay.
    // The frame background above is still correct, so this is not fatal.
  }
}
