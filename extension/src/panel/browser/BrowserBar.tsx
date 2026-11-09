/** While browser control is on: a bar under the panel header with Stop (the kill switch:
 *  detaches from every tab at once), and what the agent stopped at, if anything. */
import { useState } from 'react'
import { MonitorSmartphone, Square } from 'lucide-react'
import { storage } from '@/shared/storage'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { useStored } from '../state/useStored'
import { setBrowserControl } from './switch'

export function BrowserBar() {
  const active = useStored('session', 'browserActive').value
  const notice = useStored('session', 'browserNotice').value
  const [openedAt] = useState(() => Date.now())
  const showNotice = notice && notice.at > openedAt - 10 * 60_000
  if (!active?.on && !showNotice) return null
  const showTab = async () => {
    if (!notice) return
    const tab = await chrome.tabs.update(notice.tabId, { active: true }).catch(() => null)
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
    await storage.set('session', 'browserNotice', null)
  }
  return (
    <>
      {active?.on && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-warning/10 px-3 text-[12px]" role="status">
          <MonitorSmartphone className="h-3.5 w-3.5 shrink-0 text-warning" />
          <span className="flex-1 truncate">Anemo can use this browser (its “Anemo” tab group)</span>
          <button type="button" onClick={() => void setBrowserControl(false)} className="flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-error hover:bg-error/10">
            <Square className="h-3 w-3" /> Stop
          </button>
        </div>
      )}
      {showNotice && notice && (
        <div className="px-3 pt-3">
          <Notice
            tone="warning"
            title={notice.title}
            actions={
              <>
                <Button size="sm" onClick={() => void showTab()}>Show the tab</Button>
                <Button size="sm" variant="ghost" onClick={() => void storage.set('session', 'browserNotice', null)}>Dismiss</Button>
              </>
            }
          >
            {notice.body}
          </Notice>
        </div>
      )}
    </>
  )
}
