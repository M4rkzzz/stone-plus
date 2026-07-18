import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const isElectron = Boolean(window.stone)
document.documentElement.classList.toggle('is-electron', isElectron)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isElectron && <div className="window-titlebar" aria-hidden="true" />}
    <App />
  </StrictMode>,
)
