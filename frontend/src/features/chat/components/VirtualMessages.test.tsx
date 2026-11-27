import { render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { VIRTUAL_FROM, VirtualMessages } from './VirtualMessages'

// jsdom lays nothing out: a chat 600 px high, each message 100 px.
beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(700)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100)
})

const messages = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, text: `Message ${i}` }))

function Chat({ onResize }: { onResize: () => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  return (
    <div ref={scroller} style={{ overflowY: 'auto', height: 600 }}>
      <VirtualMessages items={messages} scroller={scroller} onResize={onResize} render={(m) => <p>{m.text}</p>} />
    </div>
  )
}

describe('a long chat', () => {
  it('is windowed only from VIRTUAL_FROM messages', () => {
    expect(VIRTUAL_FROM).toBeGreaterThan(20)
    expect(VIRTUAL_FROM).toBeLessThan(500)
  })

  it('has only the messages in sight in the page, with room for all of them', () => {
    const onResize = vi.fn()
    render(<Chat onResize={onResize} />)
    const shown = screen.getAllByText(/^Message \d+$/)
    expect(shown.length).toBeGreaterThan(3)
    expect(shown.length).toBeLessThan(30) // not 500
    expect(shown[0]).toHaveTextContent('Message 0')
    // Room for all 500: the ones drawn as measured (100 px), the others as estimated (180).
    const drawn = document.querySelectorAll('[data-index]').length
    expect(screen.getByTestId('virtual-messages').style.height).toBe(`${drawn * 100 + (500 - drawn) * 180}px`)
    // The chat hears of the height, to stay at the bottom while it is there.
    expect(onResize).toHaveBeenCalled()
  })
})
