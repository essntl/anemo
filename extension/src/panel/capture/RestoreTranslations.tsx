import { useEffect, useState } from 'react'
import { Languages } from 'lucide-react'
import { Button } from '../ui/Button'
import { useStored } from '../state/useStored'
import { activeTab } from '../chat/currentTab'

/** "Restore all" for translations on the tab you're looking at. */
export function RestoreTranslations() {
  const translated = useStored('session', 'translatedTabs').value ?? {}
  const [tabId, setTabId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const update = () => void activeTab().then((t) => setTabId(t?.id ?? null))
    update()
    chrome.tabs.onActivated.addListener(update)
    return () => chrome.tabs.onActivated.removeListener(update)
  }, [])
  const count = tabId !== null ? (translated[String(tabId)] ?? 0) : 0
  if (!count) return null
  const restore = async () => {
    setError(null)
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId!, allFrames: true },
        func: () => (window as unknown as { __anemoInline?: { restoreAll: () => number } }).__anemoInline?.restoreAll(),
      })
    } catch {
      setError('This tab can’t be changed any more (it was reloaded or navigated).')
    }
  }
  return (
    <div className="flex items-center gap-2 rounded-card border border-border bg-card px-3.5 py-2.5 shadow-soft" data-testid="restore-translations">
      <Languages className="h-4 w-4 shrink-0 text-accent" />
      <div className="min-w-0 flex-1 text-[12.5px]">
        Translated text on this page ({count} {count === 1 ? 'part' : 'parts'})
        {error && <div className="text-[12px] text-error">{error}</div>}
      </div>
      <Button size="sm" onClick={() => void restore()}>Restore all</Button>
    </div>
  )
}
