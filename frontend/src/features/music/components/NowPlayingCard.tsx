import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { Loader2, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Slider } from '@/components/ui/Slider'
import { cn } from '@/lib/cn'
import { spring } from '@/lib/motion'
import { useSettings } from '@/features/settings/api'
import { formatSeconds } from '../format'
import { player, REPEAT_LABEL, usePlayer } from '../player/controller'
import { SOURCE_LABEL } from '../player/detect'
import { Artwork } from './Artwork'

/** Shuffle and repeat: a filled accent circle when on, so the state reads at a glance. */
function ModeToggle({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} aria-pressed={active} title={label} onClick={onClick}
      className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors [&>svg]:h-[18px] [&>svg]:w-[18px] pointer-coarse:h-11 pointer-coarse:w-11',
        active ? 'bg-accent text-accent-contrast shadow-soft' : 'text-muted hover:bg-surface-hover hover:text-text')}>
      {children}
    </button>
  )
}

const iconButton = 'flex h-11 w-11 items-center justify-center rounded-full text-text hover:bg-surface-hover disabled:opacity-40 [&>svg]:h-5 [&>svg]:w-5'

/** The LIVE marker for radio streams (no length, no seeking). */
export function LivePill() {
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-live/12 px-2.5 py-0.5 text-[11px] font-bold tracking-wider text-live">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-live motion-reduce:animate-none" /> LIVE
    </span>
  )
}

/** Seek slider with elapsed and total time; a LIVE marker for streams. */
export function SeekBar({ className }: { className?: string }) {
  const p = usePlayer()
  if (p.track?.live) return <div className={cn('flex justify-center', className)}><LivePill /></div>
  return (
    <div className={className}>
      <Slider label="Seek" commit="release" value={p.position} max={Math.max(1, p.duration)} step={1}
        disabled={!p.duration} onChange={player.seek}
        valueText={(v) => `${formatSeconds(v)} of ${formatSeconds(p.duration)}`} />
      <div className="mt-0.5 flex justify-between text-[11px] font-medium text-muted tabular-nums">
        <span>{formatSeconds(p.position)}</span>
        <span>{formatSeconds(p.duration)}</span>
      </div>
    </div>
  )
}

export function VolumeControl({ className }: { className?: string }) {
  const p = usePlayer()
  const Icon = p.volume === 0 ? VolumeX : p.volume < 0.5 ? Volume1 : Volume2
  return (
    <div className={cn('flex items-center gap-2 text-muted', className)}>
      <button type="button" aria-label={p.volume ? 'Mute' : 'Unmute'} onClick={player.toggleMute}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-surface-hover hover:text-text pointer-coarse:h-11 pointer-coarse:w-11">
        <Icon className="h-4 w-4" />
      </button>
      <Slider label="Volume" className="flex-1" value={p.volume} onChange={player.setVolume} valueText={(v) => `${Math.round(v * 100)}%`} />
    </div>
  )
}

/** Big artwork, title, seek, the transport buttons and the volume. */
export function NowPlayingCard({ onYouTubeCheck }: { onYouTubeCheck: () => void }) {
  const p = usePlayer()
  const blur = useSettings().data?.music.blur_backdrop ?? true
  const empty = !p.queue.length
  const RepeatIcon = p.repeat === 'one' ? Repeat1 : Repeat
  return (
    <Card className="relative overflow-hidden p-5">
      {blur && p.track?.artwork && (
        <Artwork track={p.track} fill className="scale-125 opacity-25 blur-3xl" />
      )}
      <div className="relative">
        <motion.div key={p.track?.id ?? 'none'} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: p.playing ? 1 : 0.96 }}
          transition={spring.smooth} className="mx-auto aspect-square w-full max-w-[300px] overflow-hidden rounded-panel shadow-float">
          <Artwork track={p.track} className="h-full w-full" />
        </motion.div>
        <div className="mt-5 min-h-[52px] text-center">
          <h2 className="line-clamp-2 text-lg font-semibold leading-snug">{p.track?.title ?? 'Nothing playing'}</h2>
          <p className="truncate text-[13px] text-muted">
            {p.track ? p.track.artist || SOURCE_LABEL[p.track.source] : 'Paste a link to start'}
          </p>
        </div>

        <SeekBar className="mt-3" />

        <div className="mt-2 flex items-center justify-between">
          <ModeToggle label={p.shuffle ? 'Shuffle on' : 'Shuffle off'} active={p.shuffle} onClick={player.toggleShuffle}>
            <Shuffle />
          </ModeToggle>
          <button type="button" aria-label="Previous" className={iconButton} onClick={player.prev} disabled={empty}>
            <SkipBack fill="currentColor" />
          </button>
          <button type="button" onClick={player.toggle} disabled={empty} aria-label={p.playing ? 'Pause' : 'Play'}
            className="flex h-16 w-16 items-center justify-center rounded-full bg-accent text-accent-contrast shadow-float transition-transform active:scale-95 disabled:opacity-40 motion-reduce:transition-none">
            {p.status === 'buffering' ? <Loader2 className="h-6 w-6 animate-spin" />
              : p.playing ? <Pause className="h-7 w-7" fill="currentColor" />
              : <Play className="h-7 w-7 translate-x-0.5" fill="currentColor" />}
          </button>
          <button type="button" aria-label="Next" className={iconButton} onClick={player.next} disabled={empty}>
            <SkipForward fill="currentColor" />
          </button>
          <ModeToggle label={REPEAT_LABEL[p.repeat]} active={p.repeat !== 'off'} onClick={player.cycleRepeat}>
            <RepeatIcon />
          </ModeToggle>
        </div>

        <VolumeControl className="mt-3" />

        {p.error && (
          <div role="alert" className="mt-3 rounded-control bg-error/10 px-3 py-2 text-[13px] text-error">
            <p>{p.error}</p>
            {p.track?.source === 'youtube' && (
              <button type="button" onClick={onYouTubeCheck} className="mt-1 font-semibold underline underline-offset-2 hover:text-text">
                Run a YouTube check
              </button>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
