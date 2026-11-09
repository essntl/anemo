import { useState } from 'react'
import { storage } from '@/shared/storage'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { useStored } from '../state/useStored'

const SHOW_FOR_MS = 2 * 60_000

/** A message from a right-click action that couldn't finish (e.g. the page can't be read). */
export function PanelNotice() {
  const notice = useStored('session', 'panelNotice').value
  // An old notice (from before the panel was opened) isn't news.
  const [openedAt] = useState(() => Date.now())
  if (!notice || notice.at < openedAt - SHOW_FOR_MS) return null
  return (
    <div className="px-3 pt-3">
      <Notice tone="warning" title={notice.title} actions={<Button size="sm" variant="ghost" onClick={() => void storage.set('session', 'panelNotice', null)}>Dismiss</Button>}>
        {notice.body}
      </Notice>
    </div>
  )
}
