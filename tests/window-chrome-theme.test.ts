import { describe, expect, it, vi } from 'vitest'
import { applyWindowChromeTheme, TITLE_BAR_HEIGHT, windowChromePalette } from '../src/main/window-chrome'

describe('native window chrome theme', () => {
  it('keeps renderer and native chrome palette values aligned', () => {
    expect(windowChromePalette('light')).toEqual({
      background: '#f9fbfa',
      titleBar: '#f9fbfa',
      titleBarSymbol: '#3d4a45',
    })
    expect(windowChromePalette('dark')).toEqual({
      background: '#161c1a',
      titleBar: '#161c1a',
      titleBarSymbol: '#bcc7c2',
    })
  })

  it('applies background and overlay colors to a live window', () => {
    const window = {
      isDestroyed: vi.fn(() => false),
      setBackgroundColor: vi.fn(),
      setTitleBarOverlay: vi.fn(),
    }

    applyWindowChromeTheme(window as never, 'dark')

    expect(window.setBackgroundColor).toHaveBeenCalledWith('#161c1a')
    if (process.platform !== 'darwin') {
      expect(window.setTitleBarOverlay).toHaveBeenCalledWith({
        color: '#161c1a',
        symbolColor: '#bcc7c2',
        height: TITLE_BAR_HEIGHT,
      })
    }
  })

  it('does not touch a destroyed window', () => {
    const window = {
      isDestroyed: vi.fn(() => true),
      setBackgroundColor: vi.fn(),
      setTitleBarOverlay: vi.fn(),
    }

    applyWindowChromeTheme(window as never, 'light')

    expect(window.setBackgroundColor).not.toHaveBeenCalled()
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
  })
})
