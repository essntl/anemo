import { useEffect } from 'react'
import { setLanguage, useLocaleStore } from '@/lib/i18n'
import { useSettings } from './api'

/**
 * The app's language follows Settings > General: when the saved choice differs from
 * what this browser shows (a change made here or on another device), it is switched.
 * Before the settings load, and on the login page, the browser's remembered choice is used.
 */
export function useLanguageSync() {
  const saved = useSettings().data?.general.language
  useEffect(() => {
    if (saved && saved !== useLocaleStore.getState().choice) void setLanguage(saved)
  }, [saved])
}
