import { useState } from 'react'
import { assetUrl } from '@/features/appearance/api'
import { cn } from '@/lib/cn'
import { initials, useProfile } from './profile'

/**
 * Your avatar (Settings > Profile), or your initials on the accent colour when there is
 * none or it can't be loaded. Decorative: the name is always written next to it or in
 * the surrounding label, so it is hidden from screen readers.
 */
export function Avatar({ size = 28, className }: { size?: number; className?: string }) {
  const { name, avatarId } = useProfile()
  // The id whose image failed to load: then initials, until the avatar changes.
  const [failed, setFailed] = useState<string | null>(null)
  const box = { width: size, height: size }
  if (avatarId && failed !== avatarId) {
    // The server keeps 64, 128 and 256 px copies; the browser picks one for the screen.
    const small = size <= 32 ? 64 : 128
    return (
      <img src={assetUrl(avatarId, { size: small })} srcSet={`${assetUrl(avatarId, { size: small })} 1x, ${assetUrl(avatarId, { size: 256 })} 2x`}
        alt="" aria-hidden width={size} height={size} onError={() => setFailed(avatarId)} data-testid="avatar-image"
        className={cn('shrink-0 rounded-full object-cover', className)} style={box} />
    )
  }
  return (
    <span aria-hidden data-testid="avatar-initials" style={{ ...box, fontSize: Math.max(10, Math.round(size * 0.4)) }}
      className={cn('flex shrink-0 select-none items-center justify-center rounded-full bg-accent-soft font-semibold text-accent', className)}>
      {initials(name)}
    </span>
  )
}
