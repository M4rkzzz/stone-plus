import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n'
import { applyStoredThemeEarly, ThemeProvider } from './theme'
import { WindowTitlebar } from './window-titlebar'
import { applyStoredLowResourceModeEarly, LowResourceModeProvider } from './low-resource-mode'
import { RequestMonitorWindow } from './request-monitor-window'
import { PageErrorBoundaryInner, type BoundaryLabels } from './page-error-boundary'
import './styles.css'

// Root fallback lives OUTSIDE the theme/i18n providers so a throw in any of
// them (or in App's own render/effects, or the titlebar) shows a usable
// recover surface instead of a blank window. It cannot use useI18n (it wraps
// the provider), so the labels are bilingual constants.
const ROOT_FALLBACK_LABELS: BoundaryLabels = {
  title: '界面加载出错 · The interface failed to load',
  description:
    '发生了意外错误。请点击重启界面；若反复出现，请重启 Stone+。 · An unexpected error occurred. Restart the interface below; if it persists, restart Stone+.',
  retry: '重试 · Retry',
  reload: '重启界面 · Restart interface',
}

const isElectron = Boolean(window.stone)
const isRequestMonitor = new URLSearchParams(window.location.search).get('surface') === 'request-monitor'
document.documentElement.classList.toggle('is-electron', isElectron)
document.documentElement.classList.toggle('request-monitor-surface', isRequestMonitor)
if (isRequestMonitor) document.title = 'Stone+ Request Monitor'
applyStoredThemeEarly()
applyStoredLowResourceModeEarly()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PageErrorBoundaryInner labels={ROOT_FALLBACK_LABELS} resetKey="root">
      <ThemeProvider>
        <LowResourceModeProvider>
          <I18nProvider>
            {isElectron && !isRequestMonitor && <WindowTitlebar />}
            {isRequestMonitor ? <RequestMonitorWindow /> : <App />}
          </I18nProvider>
        </LowResourceModeProvider>
      </ThemeProvider>
    </PageErrorBoundaryInner>
  </StrictMode>,
)
