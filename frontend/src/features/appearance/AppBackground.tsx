/**
 * What is behind the app (Settings > Appearance > Background): nothing, a built-in
 * animated gradient, or an uploaded picture or video, with blur and a dim layer.
 *
 * Animated sources show a still frame when the system asks for reduced motion, and on
 * phones unless "Animate on phones too" is on; they pause while the tab is hidden. A
 * video is muted, loops, plays inline and has no controls. The styles are in
 * styles/appearance.css.
 */
import { useEffect, useRef, type CSSProperties } from 'react'
import { useThemeStore } from '@/features/settings/theme'
import { type AppearanceAsset, assetUrl, useAsset } from './api'
import type { Background } from './apply'
import { gradientColors } from './gradients'
import { usePageVisible, useStill } from './motion'

export function AppBackground() {
  const background = useThemeStore((s) => s.background)
  const accent = useThemeStore((s) => s.accent)
  const asset = useAsset(background.kind === 'upload' ? background.asset_id : null)
  const still = useStill(background)
  const visible = usePageVisible()

  // CSS pauses the gradient through this attribute.
  useEffect(() => {
    const root = document.documentElement
    if (visible) delete root.dataset.pageHidden
    else root.dataset.pageHidden = ''
  }, [visible])

  if (background.kind === 'none') return null
  if (background.kind === 'upload' && !asset) return null

  const style = {
    '--bg-blur': `${background.blur}px`,
    '--bg-dim': String(background.dim / 100),
  } as CSSProperties

  return (
    <div className="app-background" aria-hidden data-still={still || undefined} data-testid="app-background" style={style}>
      {background.kind === 'gradient' ? (
        <Gradient id={background.gradient} accent={accent} />
      ) : (
        <Media asset={asset!} fit={background.fit} still={still} visible={visible} />
      )}
      <div className="app-background-dim" />
    </div>
  )
}

function Gradient({ id, accent }: { id: Background['gradient']; accent: string }) {
  const [g1, g2, g3] = gradientColors(id, accent)
  return (
    <div className="app-background-media">
      <div className="app-gradient" style={{ '--g1': g1, '--g2': g2, '--g3': g3 } as CSSProperties} />
    </div>
  )
}

const FIT: Record<Background['fit'], Pick<CSSProperties, 'backgroundSize' | 'backgroundRepeat'>> = {
  cover: { backgroundSize: 'cover', backgroundRepeat: 'no-repeat' },
  contain: { backgroundSize: 'contain', backgroundRepeat: 'no-repeat' },
  tile: { backgroundSize: 'auto', backgroundRepeat: 'repeat' },
}

function Media({ asset, fit, still, visible }: { asset: AppearanceAsset; fit: Background['fit']; still: boolean; visible: boolean }) {
  if (asset.media === 'video') return <Video asset={asset} fit={fit} playing={!still && visible} />
  // An animated picture shows its first frame (made by the server) while it stands still.
  const src = asset.media === 'animated' && still && asset.poster_url ? assetUrl(asset.id, { poster: true }) : assetUrl(asset.id)
  return (
    <div
      className="app-background-media"
      data-testid="app-background-image"
      // Our own address (an id from the server), never one from a model or a page.
      style={{ backgroundImage: `url("${src}")`, backgroundPosition: 'center', ...FIT[fit] }}
    />
  )
}

function Video({ asset, fit, playing }: { asset: AppearanceAsset; fit: Background['fit']; playing: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = ref.current
    if (!video) return
    if (playing) video.play().catch(() => undefined) // autoplay refused: the first frame stays
    else video.pause()
  }, [playing])
  return (
    <video
      ref={ref}
      className="app-background-media"
      data-testid="app-background-video"
      // "#t=0.1": browsers then show a frame even before (or without) playing.
      src={`${assetUrl(asset.id)}#t=0.1`}
      muted
      loop
      playsInline
      autoPlay={playing}
      preload="auto"
      disablePictureInPicture
      disableRemotePlayback
      tabIndex={-1}
      // A video can't tile: "tile" fills like "cover".
      style={{ objectFit: fit === 'contain' ? 'contain' : 'cover' }}
    />
  )
}
