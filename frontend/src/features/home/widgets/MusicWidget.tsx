import { Music, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { Equalizer } from '@/components/ui/Equalizer'
import { cn } from '@/lib/cn'
import { Artwork } from '@/features/music/components/Artwork'
import { SeekBar } from '@/features/music/components/NowPlayingCard'
import { PasteLinkForm } from '@/features/music/components/PasteLinkForm'
import { player, upNext, usePlayer } from '@/features/music/player/controller'
import { SOURCE_LABEL } from '@/features/music/player/detect'
import type { WidgetLayout } from '../layout'
import { ROWS } from './rows'
import { WidgetHeader } from './parts'

const icon = 'flex h-9 w-9 items-center justify-center rounded-full text-text hover:bg-surface-hover pointer-coarse:h-11 pointer-coarse:w-11 [&>svg]:h-4 [&>svg]:w-4'

/** Music: what plays, the controls and progress, what's next; bigger, part of the queue. */
export function MusicWidget({ item }: { item: WidgetLayout }) {
  const p = usePlayer()
  const next = upNext(p)
  const big = item.h > 1 || item.w > 1
  return (
    <>
      <WidgetHeader title="Music" icon={<Music />} to="/music" />
      <div className="flex flex-1 flex-col gap-3 px-4 pb-4">
        {!p.queue.length ? (
          <>
            <p className="text-[13px] text-muted">Nothing queued. Paste a YouTube, SoundCloud or radio link.</p>
            <PasteLinkForm size="sm" placeholder="Paste a music link" onAdd={(link, choice) => player.add(link, { choice })} />
          </>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Artwork track={p.track} className="h-14 w-14 rounded-xl" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold">{p.track?.title}</div>
                <div className="truncate text-[12px] text-muted">{p.track ? p.track.artist || SOURCE_LABEL[p.track.source] : ''}</div>
              </div>
              <div className="flex items-center">
                <button type="button" className={icon} aria-label="Previous track" onClick={player.prev}><SkipBack fill="currentColor" /></button>
                <button type="button" aria-label={p.playing ? 'Pause music' : 'Play music'} onClick={player.toggle}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-accent-contrast shadow-soft pointer-coarse:h-11 pointer-coarse:w-11">
                  {p.playing ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="h-4 w-4 translate-x-px" fill="currentColor" />}
                </button>
                <button type="button" className={icon} aria-label="Next track" onClick={player.next}><SkipForward fill="currentColor" /></button>
              </div>
            </div>
            {p.loaded && <SeekBar />}
            {big ? (
              <ul className="-mx-2 flex flex-col" aria-label="Queue">
                {p.queue.slice(0, ROWS[item.h] + (item.w > 1 ? 2 : 0)).map((t, i) => {
                  const current = i === p.index
                  return (
                    <li key={t.id}>
                      <button type="button" onClick={() => (current ? player.toggle() : player.playIndex(i))}
                        className={cn('flex w-full items-center gap-2.5 rounded-control px-2 py-1.5 text-left', current ? 'bg-accent-soft' : 'hover:bg-surface-hover')}>
                        <Artwork track={t} className="h-7 w-7 rounded-md" />
                        <span className={cn('min-w-0 flex-1 truncate text-[13px]', current && 'font-medium text-accent')}>{t.title}</span>
                        {current && p.loaded && <Equalizer playing={p.status === 'playing'} className="text-accent" />}
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : next && (
              <button type="button" onClick={() => player.playIndex(next.index)}
                className="flex items-center gap-2.5 rounded-control bg-surface-2 px-2.5 py-1.5 text-left hover:bg-surface-hover">
                <Artwork track={next.track} className="h-7 w-7 rounded-md" />
                <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted">Up next</span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{next.track.title}</span>
              </button>
            )}
          </>
        )}
      </div>
    </>
  )
}
