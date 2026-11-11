import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'motion/react'
import { RouterProvider } from 'react-router'
import { router } from '@/app/router'
import { registerLanguages, setLanguage, storedChoice, useLocaleStore } from '@/lib/i18n'
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

/** The app, drawn again from the top when the language changes (texts are read while rendering, see lib/i18n.tsx). */
function App() {
  const locale = useLocaleStore((s) => s.locale)
  return (
    <QueryClientProvider client={queryClient}>
      {/* Movement follows the system's "reduce motion" setting (see lib/motion.ts). */}
      <MotionConfig reducedMotion="user">
        <RouterProvider key={locale} router={router} />
      </MotionConfig>
    </QueryClientProvider>
  )
}

// Each language's dictionary is fetched only when that language is used.
registerLanguages({ uk: () => import('@/locales/uk'), ru: () => import('@/locales/ru') })

// The language this browser remembers is loaded before the first paint, so nothing flashes in English.
void setLanguage(storedChoice()).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
