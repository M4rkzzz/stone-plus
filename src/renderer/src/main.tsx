import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n'
import './styles.css'

const isElectron = Boolean(window.stone)
document.documentElement.classList.toggle('is-electron', isElectron)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      {isElectron && <div className="window-titlebar" aria-hidden="true" />}
      <App />
    </I18nProvider>
  </StrictMode>,
)
