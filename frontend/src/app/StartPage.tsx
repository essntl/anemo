import { useEffect, useState } from 'react'
import { Navigate } from 'react-router'
import { NewChatPage } from '@/features/chat/pages/NewChatPage'
import { useSettings } from '@/features/settings/api'

const KEY = 'anemo.opened'

function openedBefore(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1'
  } catch {
    return true // no storage: never redirect
  }
}

/**
 * `/`: the new-chat page, except when the app has just been opened (the first page of
 * a browser session, or the installed app starting) and Settings → General → Start
 * page is Home. "New chat" leads here later in the session and stays on the new chat.
 */
export function StartPage() {
  const settings = useSettings()
  const [first] = useState(() => !openedBefore())
  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, '1')
    } catch {
      // private mode without storage
    }
  }, [])
  if (first && settings.isPending) return null
  if (first && (settings.data?.general.start_page ?? 'home') === 'home') return <Navigate to="/home" replace />
  return <NewChatPage />
}
