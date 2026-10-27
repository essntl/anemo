import type { CSSProperties } from 'react'
import { Music, Radio } from 'lucide-react'
import { cn } from '@/lib/cn'
import { artworkSrc } from '../player/detect'
import type { Track } from '../player/types'

/** A track's cover, or a note (a radio for streams). `fill` covers its positioned parent. */
export function Artwork({ track, className, fill, style }: { track: Pick<Track, 'artwork' | 'source'> | null; className?: string; fill?: boolean; style?: CSSProperties }) {
  const src = artworkSrc(track?.artwork)
  return (
    <div className={cn(fill ? 'absolute inset-0' : 'relative shrink-0', 'overflow-hidden bg-artwork', className)} style={style}>
      {src ? (
        <img src={src} alt="" draggable={false} loading="lazy" referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-muted [&>svg]:h-[45%] [&>svg]:w-[45%]">
          {track?.source === 'audio' ? <Radio /> : <Music />}
        </div>
      )}
    </div>
  )
}

/** A 2×2 collage of a playlist's first covers (one cover when there are fewer than four). */
export function Mosaic({ tracks, className }: { tracks: Pick<Track, 'artwork' | 'source'>[]; className?: string }) {
  const covers = [...new Map(tracks.filter((t) => t.artwork).map((t) => [artworkSrc(t.artwork), t])).values()].slice(0, 4)
  if (covers.length < 4) return <Artwork track={covers[0] ?? tracks[0] ?? null} className={cn('rounded-xl', className)} />
  return (
    <div className={cn('grid shrink-0 grid-cols-2 overflow-hidden rounded-xl bg-artwork', className)}>
      {covers.map((t, i) => <Artwork key={i} track={t} className="h-full w-full" />)}
    </div>
  )
}
