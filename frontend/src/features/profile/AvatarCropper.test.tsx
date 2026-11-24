import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AvatarCropper } from './AvatarCropper'

function loaded(width: number, height: number) {
  const img = document.querySelector('img')!
  Object.defineProperty(img, 'naturalWidth', { value: width })
  Object.defineProperty(img, 'naturalHeight', { value: height })
  fireEvent.load(img)
}

describe('AvatarCropper', () => {
  it('starts with the middle square and moves and zooms with the keyboard', () => {
    const onDone = vi.fn()
    const file = new File(['x'], 'me.png', { type: 'image/png' })
    render(<AvatarCropper file={file} url="blob:me" onCancel={() => {}} onDone={onDone} />)
    loaded(400, 200)
    const area = screen.getByRole('group', { name: 'Avatar crop area' })
    // The largest square is in the middle: x = 100 of 400.
    fireEvent.click(screen.getByRole('button', { name: 'Save avatar' }))
    expect(onDone).toHaveBeenLastCalledWith(file, { x: 0.25, y: 0, size: 1 })

    fireEvent.keyDown(area, { key: 'ArrowRight' }) // 5 % of the 200 px square
    fireEvent.click(screen.getByRole('button', { name: 'Save avatar' }))
    expect(onDone).toHaveBeenLastCalledWith(file, { x: 0.275, y: 0, size: 1 })

    fireEvent.keyDown(area, { key: '+' })
    fireEvent.click(screen.getByRole('button', { name: 'Save avatar' }))
    expect(onDone.mock.lastCall![1].size).toBeCloseTo(0.8)
  })
})
