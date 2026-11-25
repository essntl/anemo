import { useEffect, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { type Background, DEFAULT_BACKGROUND } from './apply'

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/toast', () => ({ toast: toastSpy }))
import { GradientPicker } from './GradientPicker'
import { distinctColor, gradientColors, gradientLayer } from './gradients'

const ACCENT = '#2a6df4'
let latest: Background

function Picker({ initial }: { initial?: Partial<Background> }) {
  const [background, setBackground] = useState<Background>({ ...DEFAULT_BACKGROUND, kind: 'gradient', ...initial })
  useEffect(() => {
    latest = background // what the picker last reported, for the assertions
  }, [background])
  return <GradientPicker background={background} accent={ACCENT} onChange={(patch) => setBackground((b) => ({ ...b, ...patch }))} />
}

const radio = (name: string) => screen.getByRole('radio', { name })

describe('the gradient picker', () => {
  it('is one radio group with exactly one choice selected', async () => {
    render(<Picker />)
    expect(screen.getByRole('radiogroup', { name: 'Gradient' })).toBeInTheDocument()
    const checked = screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true')
    expect(checked).toEqual([radio('Aurora')])
    await userEvent.click(radio('Dusk'))
    expect(latest.gradient).toBe('dusk')
    expect(screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true')).toEqual([radio('Dusk')])
  })

  it('moves and chooses with the arrow keys, with one tab stop', () => {
    render(<Picker />)
    expect(screen.getAllByRole('radio').filter((r) => r.tabIndex === 0)).toEqual([radio('Aurora')])
    fireEvent.keyDown(radio('Aurora'), { key: 'ArrowRight' })
    expect(latest.gradient).toBe('dusk')
    expect(radio('Dusk')).toHaveFocus()
    fireEvent.keyDown(radio('Dusk'), { key: 'End' })
    expect(latest.gradient).toBe('custom')
    fireEvent.keyDown(radio('Custom'), { key: 'ArrowRight' }) // wraps round
    expect(latest.gradient).toBe('aurora')
  })

  it('starts a custom gradient from a preset, and Undo brings the old one back', async () => {
    render(<Picker initial={{ gradient: 'lagoon' }} />)
    const before = latest.custom_gradient
    expect(screen.queryByTestId('custom-gradient-editor')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Customise Lagoon' }))
    expect(latest.gradient).toBe('custom')
    expect(latest.custom_gradient.colors).toEqual(gradientColors('lagoon', ACCENT))
    expect(screen.getByTestId('custom-gradient-editor')).toBeInTheDocument()
    expect(toastSpy).toHaveBeenCalledTimes(1)
    act(() => toastSpy.mock.calls[0][0].action.onClick())
    expect(latest.gradient).toBe('lagoon')
    expect(latest.custom_gradient).toEqual(before)
  })

  it('edits the custom stops, between two and four of them', async () => {
    render(<Picker initial={{ gradient: 'custom' }} />)
    expect(latest.custom_gradient.colors).toHaveLength(3)
    fireEvent.change(screen.getByRole('textbox', { name: 'Color 2 (hex)' }), { target: { value: '#123456' } })
    expect(latest.custom_gradient.colors[1]).toBe('#123456')

    await userEvent.click(screen.getByRole('button', { name: 'Add a color' }))
    expect(latest.custom_gradient.colors).toHaveLength(4)
    expect(screen.queryByRole('button', { name: 'Add a color' })).not.toBeInTheDocument() // four is the most

    await userEvent.click(screen.getByRole('button', { name: 'Remove color 4' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove color 3' }))
    expect(latest.custom_gradient.colors).toEqual(['#2a6df4', '#123456'])
    expect(screen.queryByRole('button', { name: /Remove color/ })).not.toBeInTheDocument() // two is the fewest
  })

  it('sets the style and speed, and the angle only for bands', async () => {
    render(<Picker initial={{ gradient: 'custom' }} />)
    // Spots have no direction: no angle to set.
    expect(screen.queryByRole('slider', { name: 'Angle' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: 'Sliding bands' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Fast' }))
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Angle' }), { key: 'Home' })
    expect(latest.custom_gradient).toMatchObject({ style: 'linear', speed: 'fast', angle: 0 })
  })

  it('says when a typed colour is not a colour, and puts the last one back on leaving', () => {
    render(<Picker initial={{ gradient: 'custom' }} />)
    const field = screen.getByRole('textbox', { name: 'Color 1 (hex)' })
    fireEvent.change(field, { target: { value: '#zzz' } })
    expect(screen.getByText('Use a color like #1a2b3c')).toBeInTheDocument()
    expect(field).toHaveAttribute('aria-invalid', 'true')
    fireEvent.blur(field)
    expect(field).toHaveValue('#2a6df4')
    expect(screen.queryByText('Use a color like #1a2b3c')).not.toBeInTheDocument()
  })
})

describe('gradientLayer', () => {
  it('gives a preset its colours only', () => {
    const layer = gradientLayer({ ...DEFAULT_BACKGROUND, gradient: 'dusk' }, ACCENT)
    expect(layer.dataStyle).toBeUndefined()
    expect(layer.style).toEqual({ '--g1': '#ff7e5f', '--g2': '#feb47b', '--g3': '#7b4397' })
  })

  it('gives a custom gradient its style, angle, speed and stops', () => {
    const custom = { colors: ['#111111', '#222222', '#333333', '#444444'], style: 'linear', angle: 90, speed: 'slow' } as const
    const layer = gradientLayer({ gradient: 'custom', custom_gradient: { ...custom, colors: [...custom.colors] } }, ACCENT)
    expect(layer.dataStyle).toBe('linear')
    expect(layer.style).toMatchObject({ '--g4': '#444444', '--g-angle': '90deg', '--g-duration': '90s', '--g-stops': '#111111, #222222, #333333, #444444' })
  })

  it.each([2, 3, 4])('gives every drifting spot a colour with %i colours (a missing one blanks the background)', (n) => {
    const colors = ['#111111', '#222222', '#333333', '#444444'].slice(0, n)
    const layer = gradientLayer({ gradient: 'custom', custom_gradient: { colors, style: 'drift', angle: 135, speed: 'normal' } }, ACCENT)
    const style = layer.style as Record<string, string>
    for (const i of [1, 2, 3, 4]) {
      expect(style[`--g${i}`], `--g${i}`).toBe(colors[(i - 1) % n])
      expect(style[`--p${i}`], `--p${i}`).toBeTruthy()
    }
  })
})

describe('distinctColor', () => {
  it('adds a colour you can see, not a near copy of one already there', () => {
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    const far = (a: string, b: string) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i])) > 150
    for (const existing of [['#ff7e5f', '#feb47b'], ['#2a6df4', '#00c2d4', '#c04fe0']]) {
      const added = distinctColor(existing, '#2a6df4')
      for (const c of existing) expect(far(added, c), `${added} vs ${c}`).toBe(true)
    }
  })
})
