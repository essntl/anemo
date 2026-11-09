import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { followSystemTheme } from './theme'
import './styles.css'

followSystemTheme()
void chrome.runtime.sendMessage({ type: 'panel.opened' }).catch(() => undefined)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
