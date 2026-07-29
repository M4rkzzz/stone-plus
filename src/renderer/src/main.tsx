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
import './styles.css'

const isElectron = Boolean(window.stone)
const isRequestMonitor = new URLSearchParams(window.location.search).get('surface') === 'request-monitor'
document.documentElement.classList.toggle('is-electron', isElectron)
document.documentElement.classList.toggle('request-monitor-surface', isRequestMonitor)
if (isRequestMonitor) document.title = 'Stone+ Request Monitor'
applyStoredThemeEarly()
applyStoredLowResourceModeEarly()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <LowResourceModeProvider>
        <I18nProvider>
          {isElectron && !isRequestMonitor && <WindowTitlebar />}
          {isRequestMonitor ? <RequestMonitorWindow /> : <App />}
        </I18nProvider>
      </LowResourceModeProvider>
    </ThemeProvider>
  </StrictMode>,
)
