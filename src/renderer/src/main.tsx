import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n'
import { applyStoredThemeEarly, ThemeProvider } from './theme'
import { WindowTitlebar } from './window-titlebar'
import './styles.css'

const isElectron = Boolean(window.stone)
document.documentElement.classList.toggle('is-electron', isElectron)
applyStoredThemeEarly()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <I18nProvider>
        {isElectron && <WindowTitlebar />}
        <App />
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>,
)
