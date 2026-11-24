import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useThemeStore } from '@/features/settings/theme'
import type { AppearanceAsset } from './api'
import { AppBackground } from './AppBackground'
import { DEFAULT_APPEARANCE, DEFAULT_BACKGROUND } from './apply'
import { PHONE, REDUCED_MOTION } from './motion'

const media = vi.hoisted(() => ({ reduced: false, phone: false }))
vi.mock('@/hooks/useMediaQuery', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/hooks/useMediaQuery')>()
  return { ...real, useMediaQuery: (q: string) => (q === REDUCED_MOTION ? media.reduced : q === PHONE ? media.phone : false) }
})

const asset = (id: string, media: AppearanceAsset['media'], poster = false): AppearanceAsset => ({
  id, kind: 'background', media, mime: '', size: 1, filename: id, created_at: '',
  url: `/api/appearance/assets/${id}/content`,
  poster_url: poster ? `/api/appearance/assets/${id}/content?variant=poster` : null,
})
const ASSETS = [asset('pic', 'image'), asset('loop', 'animated', true), asset('clip', 'video')]

function show(background: Partial<typeof DEFAULT_BACKGROUND>) {
  useThemeStore.setState({ ...DEFAULT_APPEARANCE, background: { ...DEFAULT_BACKGROUND, ...background } })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(['appearance', 'assets'], ASSETS)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  return render(<AppBackground />, { wrapper })
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
  act(() => void document.dispatchEvent(new Event('visibilitychange')))
}

describe('AppBackground', () => {
  beforeEach(() => {
    media.reduced = false
    media.phone = false
    setHidden(false)
  })

  it('draws nothing without a background', () => {
    show({ kind: 'none' })
    expect(screen.queryByTestId('app-background')).not.toBeInTheDocument()
  })

  it('applies blur and dim, and the fit of a picture', () => {
    show({ kind: 'upload', asset_id: 'pic', blur: 12, dim: 40, fit: 'tile' })
    const layer = screen.getByTestId('app-background')
    expect(layer.style.getPropertyValue('--bg-blur')).toBe('12px')
    expect(layer.style.getPropertyValue('--bg-dim')).toBe('0.4')
    const image = screen.getByTestId('app-background-image')
    expect(image.style.backgroundImage).toContain('/api/appearance/assets/pic/content')
    expect(image.style.backgroundRepeat).toBe('repeat')
  })

  it('shows the still of an animated picture with reduced motion', () => {
    media.reduced = true
    show({ kind: 'upload', asset_id: 'loop' })
    expect(screen.getByTestId('app-background')).toHaveAttribute('data-still')
    expect(screen.getByTestId('app-background-image').style.backgroundImage).toContain('variant=poster')
  })

  it('stands still on phones unless asked to move', () => {
    media.phone = true
    show({ kind: 'gradient' })
    expect(screen.getByTestId('app-background')).toHaveAttribute('data-still')
  })

  it('plays a muted video without controls, and pauses it in a hidden tab', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    show({ kind: 'upload', asset_id: 'clip', animate_on_phones: true })
    const video = screen.getByTestId('app-background-video') as HTMLVideoElement
    expect(video.muted).toBe(true)
    expect(video.controls).toBe(false)
    expect(video).toHaveAttribute('playsinline')
    expect(play).toHaveBeenCalled()
    setHidden(true)
    expect(pause).toHaveBeenCalled()
    expect(document.documentElement).toHaveAttribute('data-page-hidden')
  })
})
