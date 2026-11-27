import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APPEARANCE } from './apply'
import { isFullWidth, withPageChoice } from './fullWidthPages'
import { parseImport } from './transfer'

const desktop = vi.hoisted(() => ({ on: true }))
vi.mock('@/hooks/useMediaQuery', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/hooks/useMediaQuery')>()
  return { ...real, useMediaQuery: () => desktop.on }
})

const { useThemeStore } = await import('@/features/settings/theme')
const { FullWidthToggle } = await import('./fullWidth')
const { useFullWidth } = await import('./useFullWidth')

function Page() {
  return <div data-testid="page" data-full={String(useFullWidth('chat'))}><FullWidthToggle page="chat" /></div>
}

describe('full width', () => {
  beforeEach(() => {
    desktop.on = true
    window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never
    useThemeStore.getState().hydrate({ ...DEFAULT_APPEARANCE })
  })

  it('is off by default, as the page was', () => {
    expect(DEFAULT_APPEARANCE.full_width).toBe(false)
    render(<Page />)
    expect(screen.getByTestId('page')).toHaveAttribute('data-full', 'false')
    expect(screen.getByRole('button', { name: 'Full width' })).toHaveAttribute('aria-pressed', 'false')
  })

  it("follows the setting unless the page's own button chose", () => {
    expect(isFullWidth('chat', true, {})).toBe(true)
    expect(isFullWidth('chat', true, { chat: false })).toBe(false)
    expect(isFullWidth('home', false, { chat: true })).toBe(false)
    // A choice that matches the setting is not kept; the other pages' stay.
    expect(withPageChoice({ home: true }, 'chat', true, false)).toEqual({ home: true, chat: true })
    expect(withPageChoice({ home: true, chat: true }, 'chat', false, false)).toEqual({ home: true })
  })

  it('switches one page with its button and remembers it', () => {
    render(<Page />)
    fireEvent.click(screen.getByRole('button', { name: 'Full width' }))
    expect(screen.getByTestId('page')).toHaveAttribute('data-full', 'true')
    expect(useThemeStore.getState().full_width_pages).toEqual({ chat: true })
    expect(useThemeStore.getState().editVersion).toBeGreaterThan(0) // saved like any appearance change
  })

  it('leaves phones alone', () => {
    desktop.on = false
    useThemeStore.getState().hydrate({ ...DEFAULT_APPEARANCE, full_width: true })
    render(<Page />)
    expect(screen.getByTestId('page')).toHaveAttribute('data-full', 'false')
    expect(screen.queryByRole('button', { name: 'Full width' })).toBeNull()
  })

  it('travels in an appearance file, unknown pages dropped', () => {
    const file = JSON.stringify({ format: 'anemo.appearance', version: 1, appearance: { full_width: true, full_width_pages: { home: false, stats: true, chat: 'yes' } } })
    const imported = parseImport(file, [])
    expect(imported.full_width).toBe(true)
    expect(imported.full_width_pages).toEqual({ home: false })
  })
})
