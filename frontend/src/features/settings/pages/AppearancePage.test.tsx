import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APPEARANCE } from '@/features/appearance/apply'
import { useThemeStore } from '../theme'
import { AppearancePage } from './AppearancePage'

// jsdom has no matchMedia: light system theme, a desktop with a mouse.
vi.mock('@/hooks/useMediaQuery', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/hooks/useMediaQuery')>()
  return { ...real, useMediaQuery: () => false }
})

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(['settings'], { appearance: DEFAULT_APPEARANCE, profile: { display_name: 'Artem', avatar_id: null } })
  qc.setQueryData(['auth', 'me'], { username: 'admin' })
  qc.setQueryData(['appearance', 'assets'], [])
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  return render(<AppearancePage />, { wrapper })
}

describe('Settings > Appearance', () => {
  beforeEach(() => {
    window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never
    useThemeStore.getState().hydrate({ ...DEFAULT_APPEARANCE, mode: 'light' })
  })

  it('applies a preset accent to the whole page at once', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Accent #1f9d6b' }))
    expect(useThemeStore.getState().accent).toBe('#1f9d6b')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#1f9d6b')
    expect(screen.getByRole('button', { name: 'Accent #1f9d6b' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('takes a typed hex colour once it is complete, and can reset it', () => {
    renderPage()
    const field = screen.getByRole('textbox', { name: 'Custom accent color (hex)' })
    fireEvent.change(field, { target: { value: '#12' } })
    expect(useThemeStore.getState().accent).toBe(DEFAULT_APPEARANCE.accent)
    expect(field).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(field, { target: { value: '7B2FF7' } })
    expect(useThemeStore.getState().accent).toBe('#7b2ff7')
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
    expect(useThemeStore.getState().accent).toBe(DEFAULT_APPEARANCE.accent)
    expect(field).toHaveValue(DEFAULT_APPEARANCE.accent)
  })

  it('warns when the accent makes text hard to read', () => {
    renderPage()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Custom accent color (hex)' }), { target: { value: '#f2f2f2' } })
    const status = screen.getByRole('status')
    expect(within(status).getAllByText(/hard to see on the page/).length).toBeGreaterThan(0)
  })

  it('turns frosted glass on for the whole page', () => {
    renderPage()
    fireEvent.click(screen.getByRole('switch', { name: 'Frosted glass' }))
    expect(useThemeStore.getState().glass).toBe(true)
    expect(document.documentElement.dataset.glass).toBe('on')
  })

  it('offers blur and dim once there is a background', () => {
    renderPage()
    expect(screen.queryByRole('slider', { name: 'Blur' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Animated gradient' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dusk' }))
    expect(useThemeStore.getState().background).toMatchObject({ kind: 'gradient', gradient: 'dusk' })
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Blur' }), { key: 'End' })
    expect(useThemeStore.getState().background.blur).toBe(40)
    expect(screen.getByRole('switch', { name: 'Animate on phones too' })).toBeInTheDocument()
  })

  it('keeps this device to itself when asked', () => {
    renderPage()
    fireEvent.click(screen.getByRole('switch', { name: 'Use a different appearance on this device' }))
    expect(useThemeStore.getState().deviceOnly).toBe(true)
    expect(localStorage.getItem('anemo.appearance.thisDevice')).toBe('1')
    fireEvent.click(screen.getByRole('switch', { name: 'Use a different appearance on this device' }))
    expect(localStorage.getItem('anemo.appearance.thisDevice')).toBeNull()
  })
})
