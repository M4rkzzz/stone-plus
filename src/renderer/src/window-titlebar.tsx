import { Moon, Sun } from 'lucide-react'
import { useI18n } from './i18n'
import { useTheme } from './theme'

/**
 * The Electron title bar. The bar itself is a drag region; interactive children
 * opt out via `app-region: no-drag` so clicks reach them instead of moving the
 * window. On Windows `env(titlebar-area-width)` already excludes the native
 * caption buttons, so anchoring to the right edge puts this left of them.
 */
export function WindowTitlebar() {
  const { t } = useI18n()
  const { theme, setPreference } = useTheme()
  const nextTheme = theme === 'dark' ? 'light' : 'dark'
  const label = nextTheme === 'dark' ? t('切换到深色', 'Switch to dark') : t('切换到浅色', 'Switch to light')

  return (
    <div className="window-titlebar">
      <div className="window-titlebar__actions">
        <button
          type="button"
          className="window-titlebar__button"
          onClick={() => setPreference(nextTheme)}
          title={label}
          aria-label={label}
        >
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
    </div>
  )
}
