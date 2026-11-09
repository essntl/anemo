/**
 * Settings → Browser control (feature 12): switch it on for now, stop it, and the sites it
 * never uses. Shown once the feature's permissions are given (Features above).
 */
import { useState } from 'react'
import { Plus, RotateCcw, X } from 'lucide-react'
import { DEFAULT_BLOCKLIST, normalizeEntry } from '@/shared/browserControl'
import { formatWhen } from '@/shared/format'
import { setBrowserControl } from './switch'
import { Button } from '../ui/Button'
import { Card, CardBody, CardHeader } from '../ui/Card'
import { Input } from '../ui/Input'
import { Switch } from '../ui/Switch'
import { usePreferences } from '../state/preferences'
import { useStored } from '../state/useStored'

export function BrowserControlCard() {
  const { prefs, update } = usePreferences()
  const active = useStored('session', 'browserActive').value
  const [entry, setEntry] = useState('')
  const [error, setError] = useState<string | null>(null)
  if (!prefs.features.browserControl) return null
  const on = Boolean(active?.on)

  const add = async () => {
    const normalized = normalizeEntry(entry)
    if (!normalized) {
      setError('That isn’t a site address (try “example.com” or “example.com/account”).')
      return
    }
    setError(null)
    setEntry('')
    if (!prefs.browserBlocklist.includes(normalized)) await update((p) => ({ ...p, browserBlocklist: [...p.browserBlocklist, normalized] }))
  }

  return (
    <Card>
      <CardHeader
        title="Browser control"
        description="Anemo’s agent can open pages in an “Anemo” tab group of this Chrome and use them with your logins. It never sees your other tabs. Reading and following links are free; every other click and all typing wait for your approval."
        actions={<Switch label="Let Anemo use this browser now" checked={on} onChange={(v) => void setBrowserControl(v)} />}
      />
      <CardBody className="flex flex-col gap-3">
        <p className="text-[12.5px] text-muted">
          {on && active ? `On since ${formatWhen(new Date(active.since).toISOString())}. It goes off after 10 minutes without use, when the browser closes, or with Stop.` : 'Off. Switch it on when you want the agent to use this browser.'}
        </p>
        <p className="rounded-control bg-surface-2 px-3 py-2 text-[12px] text-muted">
          Best used in a separate Chrome profile that is signed in only where you want the agent to act: it can use whatever the browser is logged in to.
        </p>
        <div className="flex flex-col gap-1.5">
          <div className="text-[13px] font-medium">Never used</div>
          <p className="text-[12px] text-muted">Always: Anemo itself, Chrome’s own pages, government sites (.gov) and addresses with “bank” in them. And these:</p>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void add()
            }}
          >
            <Input aria-label="Site to never use" placeholder="example.com" value={entry} onChange={(e) => setEntry(e.target.value)} />
            <Button type="submit" size="md" aria-label="Add to the blocklist" icon={<Plus className="h-4 w-4" />} disabled={!entry.trim()}>
              Add
            </Button>
          </form>
          {error && <p className="text-[12px] text-error">{error}</p>}
          <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto" aria-label="Blocklist">
            {prefs.browserBlocklist.map((s) => (
              <li key={s} className="flex items-center gap-2 rounded-control border border-border px-3 py-1 text-[12.5px]">
                <span className="flex-1 truncate">{s}</span>
                <Button size="icon" variant="ghost" aria-label={`Remove ${s} from the blocklist`} onClick={() => void update((p) => ({ ...p, browserBlocklist: p.browserBlocklist.filter((x) => x !== s) }))} icon={<X className="h-3.5 w-3.5" />} />
              </li>
            ))}
          </ul>
          <Button size="sm" variant="ghost" className="w-fit" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => void update((p) => ({ ...p, browserBlocklist: DEFAULT_BLOCKLIST }))}>
            Back to the default list
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}
