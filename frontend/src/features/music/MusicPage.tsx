/**
 * Music: what is playing (left) and the queue or playlists (right); one column on a
 * phone. The player keeps going on every other page (PersistentLayer); Space plays
 * and pauses here.
 */
import { useState } from 'react'
import { Save, Trash2 } from 'lucide-react'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Card } from '@/components/ui/Card'
import { promptDialog } from '@/components/ui/dialogs'
import { Lingering } from '@/components/ui/Lingering'
import { Segmented } from '@/components/ui/Segmented'
import { useShortcut } from '@/hooks/useShortcut'
import { useCreatePlaylist, usePlaylists } from './api'
import { AmbientCard } from './components/AmbientCard'
import { NowPlayingCard } from './components/NowPlayingCard'
import { PlaylistsPanel } from './components/PlaylistsPanel'
import { QueuePanel } from './components/QueuePanel'
import { YouTubeCheck } from './components/YouTubeCheck'
import { player, usePlayer, usePlayerStore } from './player/controller'
import { PageHeader } from '@/components/ui/PageHeader'
import { Select } from '@/components/ui/Select'
import { SLEEP_CHOICES, stopAfter, useSleepTimer } from './player/sleep'

type Tab = 'queue' | 'playlists'

export function MusicPage() {
  const p = usePlayer()
  const playlists = usePlaylists()
  const create = useCreatePlaylist()
  const [tab, setTab] = useState<Tab>('queue')
  const [check, setCheck] = useState(false)
  useShortcut('music.toggle', () => player.toggle())

  const saveQueue = async () => {
    const name = await promptDialog({ title: 'Save the queue as a playlist', label: 'Name', placeholder: 'e.g. Deep focus', confirmLabel: 'Save' })
    if (name?.trim()) create.mutate({ name: name.trim(), tracks: usePlayerStore.getState().queue }, { onSuccess: () => setTab('playlists') })
  }
  const sleep = useSleepTimer((s) => s.minutes)
  const count = (n: number) => <span className="text-[11px] text-muted tabular-nums">{n}</span>

  return (
    <div className="mx-auto max-w-6xl p-4 md:px-8 md:pb-8 md:pt-2">
      <PageHeader title="Music">
        {/* Stop after: the music pauses by itself (for falling asleep, or the end of a work block). */}
        <Select variant="pill" aria-label="Stop after" value={sleep === null ? '' : String(sleep)}
          onValueChange={(v) => stopAfter(v ? Number(v) : null)}
          options={[{ value: '', label: 'Keep playing' }, ...SLEEP_CHOICES.map((m) => ({ value: String(m), label: `Stop after ${m} min` }))]} />
      </PageHeader>
      <p className="mb-4 max-w-2xl text-[13px] text-muted">Queue YouTube, SoundCloud or any stream, and play it from anywhere in Anemo.</p>

      {/* The player takes the left side in full height; the queue and the ambient sound are beside it. */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <NowPlayingCard onYouTubeCheck={() => setCheck(true)} />

        <div className="flex min-w-0 flex-col gap-4">
        <Card className="min-w-0 p-3 md:p-4">
          <div className="mb-3 flex items-center justify-between gap-2 px-1">
            <Segmented<Tab> label="Music" kind="tabs" controls="music" value={tab} onChange={setTab}
              options={[
                { value: 'queue', label: <>Queue {count(p.queue.length)}</>, ariaLabel: `Queue, ${p.queue.length} tracks` },
                { value: 'playlists', label: <>Playlists {count(playlists.data?.length ?? 0)}</>, ariaLabel: `Playlists, ${playlists.data?.length ?? 0}` },
              ]} />
            {tab === 'queue' && p.queue.length > 0 && (
              <ActionMenu label="Queue options" actions={[
                { label: 'Save as playlist', icon: <Save />, onSelect: () => void saveQueue() },
                { label: 'Clear queue', icon: <Trash2 />, danger: true, onSelect: player.clear },
              ]} />
            )}
          </div>
          <div role="tabpanel" id={`music-${tab}`} aria-label={tab === 'queue' ? 'Queue' : 'Playlists'}>
            {tab === 'queue' ? <QueuePanel /> : <PlaylistsPanel />}
          </div>
        </Card>
        <AmbientCard />
        </div>
      </div>

      <Lingering value={check}>
        {() => (
          <YouTubeCheck open={check} onClose={() => setCheck(false)}
            songId={p.track?.source === 'youtube' ? p.track.ref : null}
            songTitle={p.track?.source === 'youtube' ? p.track.title : undefined} />
        )}
      </Lingering>
    </div>
  )
}
