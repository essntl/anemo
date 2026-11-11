import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'motion/react'
import { RouterProvider } from 'react-router'
import { useLocaleStore } from '@/lib/i18n'
import { router } from './router'

/** The app, drawn again from the top when the language changes (texts are read while rendering, see lib/i18n.tsx). */
export function App({ queryClient }: { queryClient: QueryClient }) {
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
