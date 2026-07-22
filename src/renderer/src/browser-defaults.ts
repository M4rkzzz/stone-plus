export const BUILTIN_BROWSER_DEFAULT_URL = 'https://nvtokens.com/login?ref=RV-NLXJ-77NQ'
export const BUILTIN_BROWSER_SHORTCUTS_KEY = 'stone.builtin-browser.shortcuts.v2'
export const BUILTIN_BROWSER_LEGACY_SHORTCUTS_KEY = 'stone.builtin-browser.shortcuts.v1'

export interface BrowserShortcut {
  id: string
  name: string
  url: string
}

const DEFAULT_SHORTCUT: BrowserShortcut = {
  id: 'nvtokens-default',
  name: 'NVTokens',
  url: BUILTIN_BROWSER_DEFAULT_URL,
}
const LEGACY_DEFAULT_SHORTCUT_ID = 'aiprobe-default'

export function resolveBuiltinBrowserShortcuts(
  stored: string | null,
  migrateLegacyDefault: boolean,
): BrowserShortcut[] {
  const shortcuts = parseShortcuts(stored)
  if (!migrateLegacyDefault) return shortcuts.length ? shortcuts : [{ ...DEFAULT_SHORTCUT }]

  const legacyIndex = shortcuts.findIndex((shortcut) => shortcut.id === LEGACY_DEFAULT_SHORTCUT_ID)
  if (legacyIndex >= 0) shortcuts[legacyIndex] = { ...DEFAULT_SHORTCUT }
  if (!shortcuts.some((shortcut) => shortcut.url === BUILTIN_BROWSER_DEFAULT_URL)) {
    shortcuts.unshift({ ...DEFAULT_SHORTCUT })
  }
  return shortcuts.slice(0, 30)
}

function parseShortcuts(stored: string | null): BrowserShortcut[] {
  try {
    const parsed = JSON.parse(stored ?? '') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is BrowserShortcut => Boolean(
      item && typeof item === 'object'
      && typeof (item as BrowserShortcut).id === 'string'
      && typeof (item as BrowserShortcut).name === 'string'
      && isHttpUrl((item as BrowserShortcut).url),
    )).slice(0, 30)
  } catch {
    return []
  }
}

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}
