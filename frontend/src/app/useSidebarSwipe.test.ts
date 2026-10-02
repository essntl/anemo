import { ownsHorizontalTouch, swipeDirection } from './useSidebarSwipe'

describe('sidebar swipe', () => {
  it('recognises a quick sideways swipe', () => {
    expect(swipeDirection({ dx: 120, dy: 10, ms: 200 })).toBe('right')
    expect(swipeDirection({ dx: -90, dy: -20, ms: 300 })).toBe('left')
  })

  it('ignores scrolling, short and slow movements', () => {
    expect(swipeDirection({ dx: 80, dy: 70, ms: 200 })).toBeNull() // diagonal: the page is scrolling
    expect(swipeDirection({ dx: 30, dy: 0, ms: 100 })).toBeNull() // too short
    expect(swipeDirection({ dx: 200, dy: 0, ms: 900 })).toBeNull() // a slow drag, e.g. selecting text
  })

  it('leaves touches on fields and marked areas alone', () => {
    document.body.innerHTML = `
      <div id="page"><p id="text">hello</p><input id="field" />
        <div data-no-swipe><span id="inside">board</span></div>
        <div contenteditable="true"><span id="editor">doc</span></div>
      </div>`
    const el = (id: string) => document.getElementById(id)
    expect(ownsHorizontalTouch(el('text'))).toBe(false)
    expect(ownsHorizontalTouch(el('field'))).toBe(true)
    expect(ownsHorizontalTouch(el('inside'))).toBe(true)
    expect(ownsHorizontalTouch(el('editor'))).toBe(true)
  })
})
