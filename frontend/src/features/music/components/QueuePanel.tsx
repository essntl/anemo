import { AnimatePresence, Reorder, useDragControls } from 'motion/react'
import { ArrowDown, ArrowUp, ExternalLink, GripVertical, ListMusic, ListStart, Play, X } from 'lucide-react'
import { ActionMenu, type MenuAction } from '@/components/ui/ActionMenu'
import { EmptyState } from '@/components/ui/EmptyState'
import { Equalizer } from '@/components/ui/Equalizer'
import { cn } from '@/lib/cn'
import { spring } from '@/lib/motion'
import { usePlaylistActions } from '../usePlaylistActions'
import { player, usePlayer } from '../player/controller'
import { SOURCE_LABEL } from '../player/detect'
import type { Track } from '../player/types'
import { Artwork } from './Artwork'
import { PasteLinkForm } from './PasteLinkForm'

function QueueItem({ track, index, count, current, playing, playlistActions }: {
  track: Track; index: number; count: number; current: boolean; playing: boolean; playlistActions: MenuAction[]
}) {
  const controls = useDragControls()
  return (
    <Reorder.Item value={track.id} dragListener={false} dragControls={controls} layout="position"
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={spring.smooth} whileDrag={{ scale: 1.02, boxShadow: 'var(--shadow-float)', zIndex: 10 }}
      className="relative list-none rounded-control bg-card" data-testid="queue-item">
      <div onDoubleClick={() => player.playIndex(index)}
        className={cn('group flex items-center gap-2.5 rounded-control px-1.5 py-1.5 transition-colors', current ? 'bg-accent-soft' : 'hover:bg-surface-hover')}>
        <span onPointerDown={(e) => controls.start(e)} aria-hidden title="Drag to reorder"
          className="flex h-10 w-5 shrink-0 cursor-grab touch-none items-center justify-center text-subtle opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing pointer-coarse:opacity-100">
          <GripVertical className="h-4 w-4" />
        </span>
        <button type="button" onClick={() => (current ? player.toggle() : player.playIndex(index))} className="relative shrink-0"
          aria-label={current && playing ? `Pause ${track.title}` : `Play ${track.title}`}>
          <Artwork track={track} className="h-11 w-11 rounded-control" />
          <span className={cn('absolute inset-0 flex items-center justify-center rounded-control bg-artwork-scrim text-on-artwork transition-opacity',
            current ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 pointer-coarse:hidden')}>
            {current && playing ? <Equalizer playing /> : <Play className="h-4 w-4" fill="currentColor" />}
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <div className={cn('truncate text-[14px] font-medium', current && 'text-accent')}>{track.title}</div>
          <div className="truncate text-[12px] text-muted">
            {SOURCE_LABEL[track.source]}{track.artist && ` · ${track.artist}`}
          </div>
        </div>
        <ActionMenu label={`More for ${track.title}`}
          className="h-9 w-9 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 pointer-coarse:h-11 pointer-coarse:w-11 pointer-coarse:opacity-100"
          actions={[
            ...(current ? [] : [{ label: 'Play next', icon: <ListStart />, onSelect: () => player.playNext(track) }]),
            ...(index > 0 ? [{ label: 'Move up', icon: <ArrowUp />, onSelect: () => player.move(track.id, -1) }] : []),
            ...(index < count - 1 ? [{ label: 'Move down', icon: <ArrowDown />, onSelect: () => player.move(track.id, 1) }] : []),
            ...playlistActions,
            { label: `Open on ${SOURCE_LABEL[track.source]}`, icon: <ExternalLink />, href: track.url },
            { label: 'Remove from queue', icon: <X />, danger: true, onSelect: () => player.remove(track.id) },
          ]} />
      </div>
    </Reorder.Item>
  )
}

/** The queue: paste field, then every track, dragged into order. */
export function QueuePanel() {
  const p = usePlayer()
  const actionsFor = usePlaylistActions()
  return (
    <div>
      <PasteLinkForm onAdd={(link, choice) => player.add(link, { choice })} />
      <div className="mt-2" />
      {p.queue.length === 0 ? (
        <EmptyState icon={<ListMusic className="h-5 w-5" />} title="Your queue is empty"
          description="Paste a YouTube video or playlist, a SoundCloud track or set, or a direct audio or radio link." />
      ) : (
        <Reorder.Group axis="y" values={p.queue.map((t) => t.id)} onReorder={player.reorder} className="flex flex-col gap-0.5" aria-label="Queue">
          <AnimatePresence initial={false}>
            {p.queue.map((t, i) => (
              <QueueItem key={t.id} track={t} index={i} count={p.queue.length} current={i === p.index && p.loaded}
                playing={p.playing} playlistActions={actionsFor(t)} />
            ))}
          </AnimatePresence>
        </Reorder.Group>
      )}
    </div>
  )
}
