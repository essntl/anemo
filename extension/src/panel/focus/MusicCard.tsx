/**
 * Music controls (feature 11): the player in your Anemo tab in this Chrome. Play,
 * pause and skip; add a link (or the YouTube/SoundCloud tab you're on) to the end of the
 * queue. The extension never replaces or clears the queue.
 */
import { useEffect, useState } from 'react'
import { ExternalLink, ListPlus, Music, Pause, Play, Plus, SkipBack, SkipForward } from 'lucide-react'
import { BRIDGE_SCRIPT, isMusicPage, pickTab, type MusicCommand } from '@/shared/music'
import { Button } from '../ui/Button'
import { Card, CardBody, CardHeader } from '../ui/Card'
import { Input } from '../ui/Input'
import { useSession } from '../state/useSession'
import { useStored } from '../state/useStored'
import { activeTab } from '../chat/currentTab'

async function send(tabId: number, command: MusicCommand): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'music.command', command })
    return true
  } catch {
    return false // the tab closed, or our script isn't in it (yet)
  }
}

/** Anemo tabs in this Chrome: ask each what it plays (putting our script in if needed). */
async function findAnemoTabs(serverUrl: string): Promise<number> {
  const tabs = await chrome.tabs.query({ url: `${new URL(serverUrl).origin}/*` }).catch(() => [])
  for (const tab of tabs) {
    if (tab.id === undefined) continue
    if (!(await send(tab.id, { type: 'hello' }))) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [BRIDGE_SCRIPT] }).catch(() => undefined)
    }
  }
  return tabs.length
}

function newId(): string {
  return crypto.randomUUID()
}

export function MusicCard() {
  const { connection } = useSession()
  const reports = useStored('session', 'musicTabs')
  const added = useStored('session', 'musicAdded').value
  const [anemoTabs, setAnemoTabs] = useState<number | null>(null)
  const [link, setLink] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [here, setHere] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let gone = false
    const look = () =>
      void findAnemoTabs(connection.serverUrl).then((n) => {
        if (!gone) setAnemoTabs(n)
      })
    look()
    // The tab in front: offer it when it is YouTube or SoundCloud (its address is only
    // known where the extension may read the tab).
    const updateHere = () =>
      void activeTab().then((t) => {
        if (!gone) setHere(isMusicPage(t?.url) ? (t?.url ?? null) : null)
      })
    updateHere()
    chrome.tabs.onActivated.addListener(updateHere)
    chrome.tabs.onUpdated.addListener(updateHere)
    chrome.tabs.onRemoved.addListener(look)
    return () => {
      gone = true
      chrome.tabs.onActivated.removeListener(updateHere)
      chrome.tabs.onUpdated.removeListener(updateHere)
      chrome.tabs.onRemoved.removeListener(look)
    }
  }, [connection.serverUrl])

  const target = pickTab(Object.values(reports.value ?? {}))
  const result = added && pending && added.id === pending ? added : null
  const adding = pending !== null && result === null

  const command = async (c: MusicCommand) => {
    setError(null)
    if (!target || !(await send(target.tabId, c))) setError('The Anemo tab didn’t answer. Reload it and try again.')
  }

  const add = async (url: string) => {
    const id = newId()
    setPending(id)
    await command({ type: 'add', url, id })
  }

  const openAnemo = async () => {
    await chrome.tabs.create({ url: `${connection.serverUrl}/music`, active: false })
    setAnemoTabs((n) => (n ?? 0) + 1)
  }
  const showTab = async () => {
    if (!target) return
    const tab = await chrome.tabs.update(target.tabId, { active: true })
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
  }

  if (!target) {
    return (
      <Card>
        <CardHeader title="Music" description="Anemo’s player, in your Anemo tab." />
        <CardBody className="flex flex-col gap-2">
          {anemoTabs ? (
            <p className="text-[13px] text-muted">Waiting for the Anemo tab… If it doesn’t show up, reload it.</p>
          ) : (
            <>
              <p className="text-[13px] text-muted">Music plays in Anemo, and no Anemo tab is open in this Chrome.</p>
              <Button size="sm" className="w-fit" icon={<Music className="h-3.5 w-3.5" />} onClick={() => void openAnemo()}>
                Open Anemo’s player
              </Button>
            </>
          )}
        </CardBody>
      </Card>
    )
  }

  const s = target.state
  const playing = s.status === 'playing' || s.status === 'buffering'
  return (
    <Card>
      <CardHeader
        title="Music"
        description="Anemo’s player, in your Anemo tab."
        actions={
          <button type="button" className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline" onClick={() => void showTab()}>
            Show tab <ExternalLink className="h-3 w-3" />
          </button>
        }
      />
      <CardBody className="flex flex-col gap-3">
        <div className="min-w-0" data-testid="now-playing">
          {s.title ? (
            <>
              <div className="truncate text-[13.5px] font-medium">{s.title}</div>
              <div className="truncate text-[12px] text-muted">
                {s.artist ? `${s.artist} · ` : ''}
                {playing ? 'Playing' : 'Paused'} · {s.index + 1} of {s.queueLength}
              </div>
            </>
          ) : (
            <div className="text-[13px] text-muted">The queue is empty. Add a link below.</div>
          )}
          {s.error && <div className="mt-1 text-[12px] text-error">{s.error}</div>}
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="icon" variant="ghost" aria-label="Previous" disabled={!s.title} onClick={() => void command({ type: 'prev' })} icon={<SkipBack className="h-4 w-4" />} />
          <Button size="icon" variant="primary" aria-label={playing ? 'Pause' : 'Play'} disabled={!s.title} onClick={() => void command({ type: 'toggle' })} icon={playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />} />
          <Button size="icon" variant="ghost" aria-label="Next" disabled={!s.title} onClick={() => void command({ type: 'next' })} icon={<SkipForward className="h-4 w-4" />} />
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!link.trim()) return
            void add(link.trim())
            setLink('') // the result (or why not) shows below
          }}
        >
          <Input aria-label="Link to add to the queue" placeholder="A YouTube, SoundCloud or radio link" value={link} onChange={(e) => setLink(e.target.value)} />
          <Button type="submit" size="md" aria-label="Add to the queue" icon={<Plus className="h-4 w-4" />} disabled={!link.trim()} loading={adding && !here}>
            Add
          </Button>
        </form>
        {here && (
          <Button size="sm" className="w-fit" icon={<ListPlus className="h-3.5 w-3.5" />} loading={adding} onClick={() => void add(here)}>
            Add this tab to the queue
          </Button>
        )}
        {result && (result.ok ? <p className="text-[12px] text-muted">Added {result.count === 1 ? 'to the queue' : `${result.count} tracks to the queue`}.</p> : <p className="text-[12px] text-error">{result.error ?? 'Couldn’t add that.'}</p>)}
        {error && <p className="text-[12px] text-error">{error}</p>}
      </CardBody>
    </Card>
  )
}
