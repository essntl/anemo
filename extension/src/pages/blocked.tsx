// The focus page shown instead of a blocked site (feature 10): see FocusPage.tsx.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { followSystemTheme } from '../panel/theme'
import { FocusPage } from './FocusPage'
import '../panel/styles.css'

followSystemTheme()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FocusPage />
  </StrictMode>,
)
