import { useEffect } from 'react'
import { Navigate } from 'react-router'
import { NewChatPage } from '@/features/chat/pages/NewChatPage'
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
 * `/`: the new-chat page, except when the app has just been opened and Settings →
 * General → Start page is Home. "New chat" leads here later and stays on the new chat.
 */
const start = { redirected: false }

/** Goes to Home, once: coming back to / later in the session is a new chat. */
function GoHome() {
  useEffect(() => {
    start.redirected = true
  }, [])
  return <Navigate to="/home" replace />
}

export function StartPage() {
  const settings = useSettings()
  if (!justOpened || start.redirected) return <NewChatPage />
  if (settings.isPending) return null
  if ((settings.data?.general.start_page ?? 'home') === 'home') return <GoHome />
  return <NewChatPage />
}
