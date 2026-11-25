import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginPluginTransition, HERO, heroLayoutId, heroStyle, RUNNING_CLASS, transitionMode, useHeroStore } from './transition'

/* The card → page transition: which way it runs in which browser, and what it marks. */

/** A window as transitionMode sees it: whether motion is reduced and the API exists. */
function fakeWindow({ reduced = false, viewTransitions = true } = {}): Window {
  const doc = { documentElement: document.createElement('html') } as unknown as Document
  if (viewTransitions) (doc as unknown as { startViewTransition: () => void }).startViewTransition = () => {}
  return {
    matchMedia: (q: string) => ({ matches: reduced && q.includes('reduce') }),
    document: doc,
    setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
  } as unknown as Window
}

describe('the card → page transition', () => {
  afterEach(() => {
    vi.useRealTimers()
    useHeroStore.setState({ id: null })
  })

  it('uses the View Transitions API where the browser has it', () => {
    expect(transitionMode(fakeWindow())).toBe('view-transition')
  })

  it('falls back to motion’s layout animation without startViewTransition', () => {
    const win = fakeWindow({ viewTransitions: false })
    expect(transitionMode(win)).toBe('layout')
    expect(beginPluginTransition('anemo.x', win)).toEqual({ viewTransition: false })
    expect(heroLayoutId('anemo.x', 'card', 'layout')).toBe('plugin-card-anemo.x')
    expect(heroStyle(true, HERO, 'layout')).toBeUndefined()
  })

  it('does not animate at all when the system asks for less motion', () => {
    const win = fakeWindow({ reduced: true })
    expect(transitionMode(win)).toBe('none')
    expect(beginPluginTransition('anemo.x', win)).toEqual({ viewTransition: false })
    expect(win.document.documentElement.classList.contains(RUNNING_CLASS)).toBe(false)
    expect(heroStyle(true, HERO, 'none')).toBeUndefined()
    expect(heroLayoutId('anemo.x', 'card', 'none')).toBeUndefined()
  })

  it('names only the clicked card, and marks the document while the morph runs', () => {
    vi.useFakeTimers()
    const win = fakeWindow()
    expect(beginPluginTransition('anemo.x', win)).toEqual({ viewTransition: true })
    expect(useHeroStore.getState().id).toBe('anemo.x')
    expect(win.document.documentElement.classList.contains(RUNNING_CLASS)).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(win.document.documentElement.classList.contains(RUNNING_CLASS)).toBe(false)
    expect(heroStyle(true, HERO, 'view-transition')).toEqual({ viewTransitionName: HERO })
    expect(heroStyle(false, HERO, 'view-transition')).toBeUndefined()
  })
})
