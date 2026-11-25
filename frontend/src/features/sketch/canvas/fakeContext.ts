/**
 * For tests: a stand-in for CanvasRenderingContext2D (jsdom has no canvas). It records
 * every method call and keeps the properties set on it; measureText gives a width of
 * half the font size per character.
 */
export interface FakeCall {
  name: string
  args: unknown[]
}

export interface FakeContext {
  ctx: CanvasRenderingContext2D
  calls: FakeCall[]
  count: (name: string) => number
  reset: () => void
}

export function fakeContext(): FakeContext {
  const calls: FakeCall[] = []
  const state: Record<string | symbol, unknown> = { font: '10px sans-serif', globalAlpha: 1 }
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get(_, prop) {
      if (prop in state) return state[prop]
      if (prop === 'measureText') {
        return (text: string) => {
          const size = parseFloat(String(state.font)) || 10
          return { width: text.length * size * 0.5 }
        }
      }
      if (typeof prop === 'symbol' || prop === 'then') return undefined
      return (...args: unknown[]) => {
        calls.push({ name: prop, args })
      }
    },
    set(_, prop, value) {
      state[prop] = value
      return true
    },
  })
  return {
    ctx,
    calls,
    count: (name) => calls.filter((c) => c.name === name).length,
    reset: () => {
      calls.length = 0
    },
  }
}
