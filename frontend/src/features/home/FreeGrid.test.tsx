import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { FreeGrid } from './FreeGrid'
import { placesOf } from './gridPlaces'
import { normalizeLayout, type WidgetLayout } from './layout'

beforeAll(() => {
  // jsdom has no ResizeObserver and lays nothing out: the grid counts as wide.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 })
})

const layout = normalizeLayout([
  { id: 'focus', w: 1, h: 2, grid: { x: 0, y: 0, w: 4, h: 4 } },
  { id: 'needs', w: 1, h: 1, grid: { x: 4, y: 0, w: 4, h: 2 } },
  { id: 'music', w: 1, h: 1, grid: { x: 4, y: 2, w: 4, h: 2 } },
]).map((w) => (['focus', 'needs', 'music'].includes(w.id) ? w : { ...w, hidden: true }))

function renderGrid(editing: boolean, shown: (w: WidgetLayout) => boolean = () => true) {
  const actions = { place: vi.fn(), setHidden: vi.fn() }
  render(<FreeGrid layout={layout} places={placesOf(layout)} editing={editing} actions={actions} shown={shown}
    render={(w) => <span>{w.id} content</span>} />)
  const widget = (id: string) => document.querySelector<HTMLElement>(`[data-widget="${id}"]`)
  return { actions, widget }
}

describe('Home on the free grid', () => {
  it('puts each widget at its place', () => {
    const { widget } = renderGrid(false)
    expect(widget('focus')!.style.gridColumn).toBe('1 / span 4')
    expect(widget('focus')!.style.gridRow).toBe('1 / span 4')
    expect(widget('music')!.dataset.place).toBe('4,2,4,2')
    expect(screen.getByTestId('widget-grid')).toHaveAttribute('data-cols', '12')
  })

  it('moves what is under a widget that hides itself up into its space', () => {
    const { widget } = renderGrid(false, (w) => w.id !== 'needs')
    expect(widget('needs')).toBeNull()
    expect(widget('music')!.dataset.place).toBe('4,0,4,2')
  })

  it('moves and resizes the focused widget with the keyboard while editing', () => {
    const { actions, widget } = renderGrid(true)
    const focus = widget('focus')!
    expect(focus).toHaveAccessibleName(/Focus, 4 by 4, at column 1, row 1/)
    fireEvent.keyDown(focus, { key: 'ArrowRight' })
    expect(actions.place).toHaveBeenLastCalledWith('focus', { x: 1, y: 0, w: 4, h: 4 }, 12)
    fireEvent.keyDown(focus, { key: 'ArrowDown', shiftKey: true })
    expect(actions.place).toHaveBeenLastCalledWith('focus', { x: 0, y: 0, w: 4, h: 5 }, 12)
    fireEvent.keyDown(focus, { key: 'Delete' })
    expect(actions.setHidden).toHaveBeenCalledWith('focus', true)
  })

  it('offers the hidden widgets to put back', () => {
    const { actions } = renderGrid(true)
    fireEvent.click(screen.getByRole('button', { name: /Upcoming/ }))
    expect(actions.setHidden).toHaveBeenCalledWith('upcoming', false)
  })
})
