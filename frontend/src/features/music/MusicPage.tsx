/**
 * Music: what is playing (left) and the queue or playlists (right); one column on a
 * phone. The player keeps going on every other page (PersistentLayer); Space plays
 * and pauses here.
 */
import { useState } from 'react'
import { Music, Save, Trash2 } from 'lucide-react'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Card } from '@/components/ui/Card'
import { promptDialog } from '@/components/ui/dialogs'
import { Lingering } from '@/components/ui/Lingering'
import { Segmented } from '@/components/ui/Segmented'
import { useHotkey } from '@/hooks/useHotkey'
import { useCreatePlaylist, usePlaylists } from './api'
import { AmbientCard } from './components/AmbientCard'
import { NowPlayingCard } from './components/NowPlayingCard'
import { PlaylistsPanel } from './components/PlaylistsPanel'
import { QueuePanel } from './components/QueuePanel'
import { YouTubeCheck } from './components/YouTubeCheck'
import { player, usePlayer, usePlayerStore } from './player/controller'

type Tab = 'queue' | 'playlists'

export function MusicPage() {
  const p = usePlayer()
  const playlists = usePlaylists()
  const create = useCreatePlaylist()
  const [tab, setTab] = useState<Tab>('queue')
  const [check, setCheck] = useState(false)
  useHotkey((e) => e.key === ' ', () => player.toggle())

  const saveQueue = async () => {
    const name = await promptDialog({ title: 'Save the queue as a playlist', label: 'Name', placeholder: 'e.g. Deep focus', confirmLabel: 'Save' })
    if (name?.trim()) create.mutate({ name: name.trim(), tracks: usePlayerStore.getState().queue }, { onSuccess: () => setTab('playlists') })
  }
  const count = (n: number) => <span className="text-[11px] text-muted tabular-nums">{n}</span>

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-8 md:pt-14">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Music className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold">Music</h1>
          <p className="truncate text-[13px] text-muted">Queue YouTube, SoundCloud or any stream, and play it from anywhere in Anemo.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[400px_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <NowPlayingCard onYouTubeCheck={() => setCheck(true)} />
          <AmbientCard />
        </div>

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
