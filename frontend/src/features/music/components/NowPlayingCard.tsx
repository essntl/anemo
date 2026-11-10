import { useMemo, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { Loader2, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react'
import { Slider } from '@/components/ui/Slider'
import { cn } from '@/lib/cn'
import { spring } from '@/lib/motion'
import { useSettings } from '@/features/settings/api'
import { formatSeconds } from '../format'
import { trackGradient, waveform } from '../look'
import { player, REPEAT_LABEL, usePlayer } from '../player/controller'
import { SOURCE_LABEL } from '../player/detect'
import { Artwork } from './Artwork'

/** Shuffle and repeat: a filled accent circle when on, so the state reads at a glance. */
function ModeToggle({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} aria-pressed={active} title={label} onClick={onClick}
      className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors [&>svg]:h-[18px] [&>svg]:w-[18px] pointer-coarse:h-11 pointer-coarse:w-11',
        active ? 'bg-white/20 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white')}>
      {children}
    </button>
  )
}

const iconButton = 'flex h-12 w-12 items-center justify-center rounded-full text-white hover:bg-white/10 disabled:opacity-40 [&>svg]:h-6 [&>svg]:w-6'

/** How many bars the scrubber has. */
const BARS = 56

/**
 * The track as a row of bars, filled up to where it is playing: a picture of the
 * position only (the slider under it is what you drag).
 */
function Waveform({ seed, progress }: { seed: string | null; progress: number }) {
  const bars = useMemo(() => waveform(seed, BARS), [seed])
  return (
    <div aria-hidden className="flex h-10 items-center gap-[3px]">
      {bars.map((h, i) => (
        <span key={i} className={cn('min-w-0 flex-1 rounded-full', i / BARS < progress ? 'bg-white' : 'bg-white/30')} style={{ height: `${Math.round(h * 100)}%` }} />
      ))}
    </div>
  )
}

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
  // What the panel's colours and the scrubber's bars are worked out from (look.ts).
  const seed = p.track ? `${p.track.source}:${p.track.ref}` : null
  return (
    // A panel in the track's own hue, with light controls on it: inside it the dark theme's
    // tokens apply (data-theme), so sliders and text keep their contrast in both themes.
    <section data-theme="dark" aria-label="Now playing" style={{ backgroundImage: trackGradient(seed) }}
      className="relative flex flex-col justify-center overflow-hidden rounded-panel p-5 text-white shadow-float md:p-7 lg:min-h-[min(42rem,calc(100dvh-7rem))]">
      {/* Settings > Music: the cover, blurred, deepens the colour. Off, the gradient is all there is to paint. */}
      {blur && p.track?.artwork && (
        <Artwork track={p.track} fill className="scale-125 opacity-30 blur-3xl" />
      )}
      <div className="relative">
        <motion.div key={p.track?.id ?? 'none'} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: p.playing ? 1 : 0.96 }}
          transition={spring.smooth} className="mx-auto aspect-square w-full max-w-[300px] overflow-hidden rounded-panel shadow-[0_24px_48px_rgb(0_0_0/0.4)]">
          <Artwork track={p.track} className="h-full w-full bg-white/10 [&_svg]:text-white/50" />
        </motion.div>
        <div className="mt-5 min-h-[52px] text-center">
          <h2 className="line-clamp-2 text-[24px] font-bold leading-tight tracking-tight md:text-[28px]">{p.track?.title ?? 'Nothing playing'}</h2>
          <p className="mt-0.5 truncate text-[14px] text-white/75">
            {p.track ? p.track.artist || SOURCE_LABEL[p.track.source] : 'Paste a link to start'}
          </p>
        </div>

        {p.track && !p.track.live && <div className="mt-4"><Waveform seed={seed} progress={p.duration ? p.position / p.duration : 0} /></div>}
        <SeekBar className="mt-2" />

        <div className="mx-auto mt-3 flex max-w-sm items-center justify-between">
          <ModeToggle label={p.shuffle ? 'Shuffle on' : 'Shuffle off'} active={p.shuffle} onClick={player.toggleShuffle}>
            <Shuffle />
          </ModeToggle>
          <button type="button" aria-label="Previous" className={iconButton} onClick={player.prev} disabled={empty}>
            <SkipBack fill="currentColor" />
          </button>
          <button type="button" onClick={player.toggle} disabled={empty} aria-label={p.playing ? 'Pause' : 'Play'}
            className="flex h-[4.5rem] w-[4.5rem] items-center justify-center rounded-full bg-white text-black shadow-[0_10px_24px_rgb(0_0_0/0.35)] transition-transform active:scale-95 disabled:opacity-40 motion-reduce:transition-none">
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
          <div role="alert" className="mt-3 rounded-control bg-black/35 px-3 py-2 text-[13px] text-white">
            <p>{p.error}</p>
            {p.track?.source === 'youtube' && (
              <button type="button" onClick={onYouTubeCheck} className="mt-1 font-semibold underline underline-offset-2">
                Run a YouTube check
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
