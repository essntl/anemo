import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, Reorder, useDragControls } from 'motion/react'
import { ChevronLeft, GripVertical, ListMusic, ListPlus, Pencil, Play, Plus, RefreshCw, Save, Shuffle, Trash2, X } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Button } from '@/components/ui/Button'
import { promptDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { spring } from '@/lib/motion'
import {
  type LibraryTrack,
  type Playlist,
  useAddToPlaylist,
  useCreatePlaylist,
  useDeletePlaylist,
  usePlaylists,
  useRenamePlaylist,
  useSetPlaylistTracks,
} from '../api'
import { trackCount } from '../format'
import { buildTracks, fromLibrary, player, saveToLibrary, usePlayerStore } from '../player/controller'
import { SOURCE_LABEL } from '../player/detect'
import { Artwork, Mosaic } from './Artwork'
import { PasteLinkForm } from './PasteLinkForm'

const play = (pl: Playlist, opts: { shuffle?: boolean; startAt?: number } = {}) => player.playTracks(pl.tracks.map(fromLibrary), opts)
const enqueue = (pl: Playlist) => player.append(pl.tracks.map(fromLibrary), { label: pl.name })

function usePlaylistMenu() {
  const rename = useRenamePlaylist()
  const remove = useDeletePlaylist()
  const replace = useSetPlaylistTracks()
  return (pl: Playlist, onDeleted?: () => void) => {
    const queue = usePlayerStore.getState().queue
    return [
      { label: 'Shuffle play', icon: <Shuffle />, onSelect: () => play(pl, { shuffle: true }) },
      { label: 'Add to queue', icon: <ListPlus />, onSelect: () => enqueue(pl) },
      ...(queue.length
        ? [{
            label: 'Replace with the queue',
            icon: <RefreshCw />,
            onSelect: async () => {
              const saved = await saveToLibrary(queue)
              replace.mutate({ id: pl.id, trackIds: saved.map((t) => t.trackId).filter((id): id is string => !!id) })
            },
          }]
        : []),
      {
        label: 'Rename',
        icon: <Pencil />,
        onSelect: async () => {
          const name = await promptDialog({ title: 'Rename playlist', label: 'Name', initial: pl.name, confirmLabel: 'Rename' })
          if (name?.trim() && name.trim() !== pl.name) rename.mutate({ id: pl.id, name: name.trim() })
        },
      },
      { label: 'Delete playlist', icon: <Trash2 />, danger: true, onSelect: () => remove.mutate(pl, { onSuccess: onDeleted }) },
    ]
  }
}

function PlaylistTrack({ pl, track, index }: { pl: Playlist; track: LibraryTrack; index: number }) {
  const controls = useDragControls()
  const setTracks = useSetPlaylistTracks()
  return (
    <Reorder.Item value={track.id} dragListener={false} dragControls={controls} layout="position"
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={spring.smooth} whileDrag={{ scale: 1.02, boxShadow: 'var(--shadow-float)', zIndex: 10 }}
      className="relative list-none rounded-control bg-card">
      <div className="group flex items-center gap-2.5 rounded-control px-1.5 py-1.5 hover:bg-surface-hover">
        <span onPointerDown={(e) => controls.start(e)} aria-hidden title="Drag to reorder"
          className="flex h-9 w-5 shrink-0 cursor-grab touch-none items-center justify-center text-subtle opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100">
          <GripVertical className="h-4 w-4" />
        </span>
        <button type="button" onClick={() => play(pl, { startAt: index })} className="relative shrink-0" aria-label={`Play ${track.title}`}>
          <Artwork track={track} className="h-10 w-10 rounded-lg" />
          <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-artwork-scrim text-on-artwork opacity-0 group-hover:opacity-100 pointer-coarse:hidden">
            <Play className="h-4 w-4" fill="currentColor" />
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium">{track.title}</div>
          <div className="truncate text-[12px] text-muted">{SOURCE_LABEL[track.source]}{track.artist && ` · ${track.artist}`}</div>
        </div>
        <button type="button" aria-label={`Remove ${track.title} from ${pl.name}`}
          onClick={() => setTracks.mutate({ id: pl.id, trackIds: pl.tracks.filter((t) => t.id !== track.id).map((t) => t.id) })}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted opacity-0 hover:bg-surface-2 hover:text-text focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:h-11 pointer-coarse:w-11 pointer-coarse:opacity-100">
          <X className="h-4 w-4" />
        </button>
      </div>
    </Reorder.Item>
  )
}

/**
 * The order while tracks are being dragged, saved once dragging has settled (not on
 * every swap), so a long drag sends one request.
 */
function useDraftOrder(pl: Playlist) {
  const setTracks = useSetPlaylistTracks()
  const [draft, setDraft] = useState<string[] | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  const reorder = (ids: string[]) => {
    setDraft(ids)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setTracks.mutate({ id: pl.id, trackIds: ids }, { onSettled: () => setDraft(null) }), 600)
  }
  const byId = new Map(pl.tracks.map((t) => [t.id, t]))
  const tracks = draft ? draft.map((id) => byId.get(id)).filter((t): t is LibraryTrack => !!t) : pl.tracks
  return { tracks, reorder, error: setTracks.error }
}

function PlaylistDetail({ pl, onBack }: { pl: Playlist; onBack: () => void }) {
  const menu = usePlaylistMenu()
  const addTo = useAddToPlaylist()
  const order = useDraftOrder(pl)
  return (
    <div>
      <button type="button" onClick={onBack} className="mb-3 flex items-center gap-1 rounded-lg px-1 text-[13px] font-medium text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" /> All playlists
      </button>
      <div className="mb-4 flex items-center gap-4 px-1">
        <Mosaic tracks={pl.tracks} className="h-20 w-20 sm:h-24 sm:w-24" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-xl font-semibold tracking-tight">{pl.name}</h3>
          <p className="text-[13px] text-muted">{trackCount(pl.tracks.length)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="primary" disabled={!pl.tracks.length} icon={<Play className="h-3.5 w-3.5" fill="currentColor" />} onClick={() => play(pl)}>Play</Button>
            <Button size="sm" disabled={!pl.tracks.length} icon={<Shuffle className="h-3.5 w-3.5" />} onClick={() => play(pl, { shuffle: true })}>Shuffle</Button>
            <ActionMenu label="Playlist options" actions={menu(pl, onBack)} />
          </div>
        </div>
      </div>
      <PasteLinkForm size="sm" label="Link to add to the playlist" placeholder={`Add a link to ${pl.name}`} className="mb-2"
        onAdd={async (link, choice) => {
          const saved = await saveToLibrary(await buildTracks(link, choice))
          await addTo.mutateAsync({ playlist: pl, tracks: saved })
        }} />
      {order.error && <p className="px-1 text-[12.5px] text-error">{errorMessage(order.error)}</p>}
      {pl.tracks.length === 0 ? (
        <EmptyState icon={<ListMusic className="h-5 w-5" />} title="This playlist is empty"
          description="Paste links above, or use “Add to …” in a track's menu in the queue." />
      ) : (
        <Reorder.Group axis="y" values={order.tracks.map((t) => t.id)} className="flex flex-col gap-0.5" aria-label={`Tracks in ${pl.name}`}
          onReorder={order.reorder}>
          <AnimatePresence initial={false}>
            {order.tracks.map((t, i) => <PlaylistTrack key={t.id} pl={pl} track={t} index={i} />)}
          </AnimatePresence>
        </Reorder.Group>
      )}
    </div>
  )
}

/** Playlists (on the server, the same on every device): a list, or one opened. */
export function PlaylistsPanel() {
  const playlists = usePlaylists()
  const create = useCreatePlaylist()
  const menu = usePlaylistMenu()
  const queueLength = usePlayerStore((s) => s.queue.length)
  const [openId, setOpenId] = useState<string | null>(null)
  const open = playlists.data?.find((p) => p.id === openId) ?? null

  const ask = async (title: string, tracks = usePlayerStore.getState().queue) => {
    const name = await promptDialog({ title, label: 'Name', placeholder: 'e.g. Deep focus, Lo-fi mornings', confirmLabel: 'Save' })
    if (name?.trim()) create.mutate({ name: name.trim(), tracks }, { onSuccess: (pl) => setOpenId(pl.id) })
  }

  if (open) return <PlaylistDetail pl={open} onBack={() => setOpenId(null)} />
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5 px-1">
        <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => void ask('New playlist', [])}>New playlist</Button>
        {queueLength > 0 && (
          <Button size="sm" variant="ghost" icon={<Save className="h-3.5 w-3.5" />} onClick={() => void ask('Save the queue as a playlist')}>
            Save queue as playlist
          </Button>
        )}
      </div>
      {create.isError && <p className="mb-2 px-1 text-[12.5px] text-error">{errorMessage(create.error)}</p>}
      {playlists.isSuccess && playlists.data.length === 0 ? (
        <EmptyState icon={<ListMusic className="h-5 w-5" />} title="No playlists yet"
          description="Save your queue, or make a playlist and paste links into it. Playlists are the same on all your devices." />
      ) : (
        <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {(playlists.data ?? []).map((pl) => (
            <li key={pl.id} className="group flex items-center gap-3 rounded-card p-2 hover:bg-surface-hover">
              <button type="button" onClick={() => setOpenId(pl.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <Mosaic tracks={pl.tracks} className="h-14 w-14" />
                <span className="min-w-0">
                  <span className="block truncate text-[14.5px] font-semibold">{pl.name}</span>
                  <span className="block text-[12px] text-muted">{trackCount(pl.tracks.length)}</span>
                </span>
              </button>
              <button type="button" aria-label={`Play ${pl.name}`} disabled={!pl.tracks.length} onClick={() => play(pl)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-contrast opacity-0 shadow-soft transition-opacity focus-visible:opacity-100 group-hover:opacity-100 disabled:hidden pointer-coarse:opacity-100">
                <Play className="h-4 w-4" fill="currentColor" />
              </button>
              <ActionMenu label={`More for ${pl.name}`} actions={menu(pl)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
