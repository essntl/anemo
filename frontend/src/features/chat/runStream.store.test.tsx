import { useEffect } from 'react'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type RunStore, type RunView, shallowEqual, useRunSelector, useRunStore } from './runStream'

/** A stand-in EventSource the test sends events through. */
class FakeSource {
  static last: FakeSource | null = null
  listeners = new Map<string, (e: MessageEvent<string>) => void>()
  url: string
  constructor(url: string) {
    this.url = url
    FakeSource.last = this
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, fn)
  }
  close() {}
  emit(type: string, data: object) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>)
  }
}

const status = (v: RunView) => ({ status: v.status, error: v.error })
const text = (v: RunView) => v.text

describe('a run store: each part re-renders only for its own changes', () => {
  beforeEach(() => vi.stubGlobal('EventSource', FakeSource))
  afterEach(() => vi.unstubAllGlobals())

  it('a text delta re-renders what shows the text, not what shows the status', () => {
    const renders = { page: 0, status: 0, text: 0 }
    const rendered = (part: keyof typeof renders) => {
      renders[part] += 1
    }
    const held: { store: RunStore | null } = { store: null }
    function Status({ s }: { s: RunStore }) {
      rendered('status')
      return <span>{useRunSelector(s, status, shallowEqual).status}</span>
    }
    function Text({ s }: { s: RunStore }) {
      rendered('text')
      return <p>{useRunSelector(s, text)}</p>
    }
    function Page() {
      rendered('page')
      const store = useRunStore('run-1')
      useEffect(() => {
        held.store = store
      })
      return <><Status s={store} /><Text s={store} /></>
    }
    const { container } = render(<Page />)
    const before = { ...renders }
    act(() => {
      for (const word of ['Hello', ' there', '!']) FakeSource.last!.emit('message.delta', { text: word })
    })
    expect(container.querySelector('p')?.textContent).toBe('Hello there!')
    expect(renders.page).toBe(before.page)
    expect(renders.status).toBe(before.status)
    expect(renders.text).toBeGreaterThan(before.text)
    act(() => FakeSource.last!.emit('run.status', { status: 'running' }))
    expect(container.querySelector('span')?.textContent).toBe('running')
    expect(renders.page).toBe(before.page)
    expect(held.store?.get().text).toBe('Hello there!')
  })
})
