import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { Avatar } from './Avatar'
import { clampCrop, toCropBox, zoomTo } from './crop'
import { initials } from './profile'

describe('initials', () => {
  it('takes the first letters of two words, or two letters of one', () => {
    expect(initials('Artem Kotov')).toBe('AK')
    expect(initials('admin')).toBe('AD')
    expect(initials('jane.doe')).toBe('JD')
    expect(initials('  ')).toBe('')
    expect(initials('Олена')).toBe('ОЛ')
  })
})

function withProfile(profile: { display_name: string; avatar_id: string | null }, username = 'admin') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(['settings'], { profile })
  qc.setQueryData(['auth', 'me'], { username })
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('Avatar', () => {
  it('shows the picture in the size the screen needs', () => {
    render(<Avatar size={28} />, { wrapper: withProfile({ display_name: 'Artem', avatar_id: 'abc' }) })
    const img = screen.getByTestId('avatar-image')
    expect(img).toHaveAttribute('src', '/api/appearance/assets/abc/content?size=64')
    expect(img.getAttribute('srcset')).toContain('size=256 2x')
  })

  it('falls back to initials without a picture, or when it fails to load', () => {
    const { unmount } = render(<Avatar />, { wrapper: withProfile({ display_name: 'Artem Kotov', avatar_id: null }) })
    expect(screen.getByTestId('avatar-initials')).toHaveTextContent('AK')
    unmount()
    render(<Avatar />, { wrapper: withProfile({ display_name: '', avatar_id: 'gone' }, 'admin') })
    fireEvent.error(screen.getByTestId('avatar-image'))
    expect(screen.getByTestId('avatar-initials')).toHaveTextContent('AD')
  })
})

describe('the crop square', () => {
  it('stays inside the picture', () => {
    expect(clampCrop(400, 200, { x: 500, y: -10, zoom: 1 })).toEqual({ x: 200, y: 0, zoom: 1 })
    expect(clampCrop(400, 200, { x: 0, y: 0, zoom: 9 }).zoom).toBe(4)
  })

  it('zooms around its middle', () => {
    // 200 px square at (100, 0); at zoom 2 it is 100 px, so its corner moves by 50.
    expect(zoomTo(400, 200, { x: 100, y: 0, zoom: 1 }, 2)).toEqual({ x: 150, y: 50, zoom: 2 })
  })

  it('is sent as fractions of the picture', () => {
    expect(toCropBox(400, 200, { x: 100, y: 50, zoom: 2 })).toEqual({ x: 0.25, y: 0.25, size: 0.5 })
  })
})
