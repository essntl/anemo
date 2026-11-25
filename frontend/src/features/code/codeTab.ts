/** Which tab the Code page shows over the open job: the thread, or a plugin's (CodePluginTabs.tsx). */
import { useCallback, useState } from 'react'
import type { PluginCodeTab } from '@/features/plugins/slotData'

/** The thread's own tab. */
export const JOB_TAB = 'job'
const TAB_KEY = 'anemo.code.tab'

function storedTab(): string {
  try {
    return localStorage.getItem(TAB_KEY) || JOB_TAB
  } catch {
    return JOB_TAB
  }
}

/**
 * The tab chosen last (remembered on this device), as one of `tabs`: one that isn't there
 * (its plugin turned off, or still loading) shows the job.
 */
export function useCodeTab(tabs: readonly PluginCodeTab[]): [string, (tab: string) => void] {
  const [chosen, setChosen] = useState(storedTab)
  const choose = useCallback((tab: string) => {
    try {
      localStorage.setItem(TAB_KEY, tab)
    } catch {
      // no storage: just not remembered
    }
    setChosen(tab)
  }, [])
  return [tabs.some((tab) => tab.id === chosen) ? chosen : JOB_TAB, choose]
}
