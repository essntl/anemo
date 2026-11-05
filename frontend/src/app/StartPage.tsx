import { useEffect } from 'react'
import { Navigate } from 'react-router'
import { NewChatPage } from '@/features/chat/pages/NewChatPage'
import { useSetupStatus } from '@/features/providers/api'
import { useSettings } from '@/features/settings/api'

const KEY = 'anemo.opened'

/**
 * Whether this page load is the app being opened (the first load in this browser tab or
 * the installed app starting), decided once when the app loads, so a later render or
 * a reload in the same tab never changes it.
 */
const justOpened = (() => {
  try {
    const opened = sessionStorage.getItem(KEY) === '1'
    sessionStorage.setItem(KEY, '1')
    return !opened
  } catch {
    return false // no storage: never redirect
  }
})()

/**
 * `/`: the new-chat page, except when the app has just been opened: then the first-run
 * setup while nothing is set up yet, or Home when Settings → General → Start page says
 * so. "New chat" leads here later and stays on the new chat.
 */
const start = { redirected: false }

/** Goes elsewhere, once: coming back to / later in the session is a new chat. */
function GoOnce({ to }: { to: string }) {
  useEffect(() => {
    start.redirected = true
  }, [])
  return <Navigate to={to} replace />
}

export function StartPage() {
  const settings = useSettings()
  const setup = useSetupStatus()
  if (!justOpened || start.redirected) return <NewChatPage />
  if (settings.isPending || setup.isPending) return null
  if (setup.data?.offer_setup) return <GoOnce to="/setup" />
  if ((settings.data?.general.start_page ?? 'home') === 'home') return <GoOnce to="/home" />
  return <NewChatPage />
}
