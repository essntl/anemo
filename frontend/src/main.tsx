import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient } from '@tanstack/react-query'
import { App } from '@/app/App'
import { registerLanguages, setLanguage, storedChoice } from '@/lib/i18n'
import { applyAppearance, useThemeStore, watchSystemTheme } from '@/features/settings/theme'
import '@/styles/app.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
})

const { mode, accent, density } = useThemeStore.getState()
applyAppearance({ mode, accent, density })
watchSystemTheme()

// Installable app: register the service worker (production builds only; it never caches /api).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js'))
}

// Each language's dictionary is fetched only when that language is used.
registerLanguages({ uk: () => import('@/locales/uk'), ru: () => import('@/locales/ru') })

// The language this browser remembers is loaded before the first paint, so nothing flashes in English.
void setLanguage(storedChoice()).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App queryClient={queryClient} />
    </StrictMode>,
  )
})
