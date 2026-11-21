import { render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { insertText, joinText, textTarget } from './insert'
import { parseVocabulary } from './vocabulary'

function Controlled({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <textarea aria-label="box" value={value} onChange={(e) => setValue(e.target.value)} />
      <output>{value}</output>
    </>
  )
}

describe('inserting dictated text', () => {
  it('reaches React as if typed, at the caret', () => {
    render(<Controlled initial="Hello world" />)
    const box = screen.getByLabelText('box') as HTMLTextAreaElement
    box.setSelectionRange(5, 5)
    insertText(box, 'there')
    expect(screen.getByRole('status')).toHaveTextContent('Hello there world')
    expect(box.selectionStart).toBe('Hello there'.length)
  })

  it('goes at the end of an empty box without a leading space', () => {
    render(<Controlled />)
    const box = screen.getByLabelText('box') as HTMLTextAreaElement
    insertText(box, '  Add milk to the list.\n')
    expect(box.value).toBe('Add milk to the list.')
    expect(document.activeElement).toBe(box)
  })

  it('joins lines in a one-line input', () => {
    render(<input aria-label="title" defaultValue="" />)
    const input = screen.getByLabelText('title') as HTMLInputElement
    insertText(input, 'First\n\n- second')
    expect(input.value).toBe('First - second')
  })

  it('adds a space only where words would run together', () => {
    expect(joinText('', 'Hi')).toBe('Hi')
    expect(joinText('Say', 'hi')).toBe(' hi')
    expect(joinText('Say ', 'hi')).toBe('hi')
    expect(joinText('Say', ', hi')).toBe(', hi')
  })

  it('finds the text field to dictate into', () => {
    render(
      <div>
        <textarea aria-label="t" />
        <textarea aria-label="ro" readOnly />
        <input aria-label="check" type="checkbox" />
        <input aria-label="search" type="search" />
        <button type="button">b</button>
      </div>,
    )
    expect(textTarget(screen.getByLabelText('t'))).toBe(screen.getByLabelText('t'))
    expect(textTarget(screen.getByLabelText('ro'))).toBeNull()
    expect(textTarget(screen.getByLabelText('check'))).toBeNull()
    expect(textTarget(screen.getByLabelText('search'))).toBe(screen.getByLabelText('search'))
    expect(textTarget(screen.getByRole('button'))).toBeNull()
    expect(textTarget(null)).toBeNull()
  })
})

describe('the word list', () => {
  it('takes one word per line or comma, without blanks or doubles', () => {
    expect(parseVocabulary('Anemo\n\n Kubernetes , Anemo,Astrid Lindqvist\n')).toEqual(['Anemo', 'Kubernetes', 'Astrid Lindqvist'])
  })
})
