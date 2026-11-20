import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FilterChips } from './FilterChips'

describe('filter chips', () => {
  it('shows a known filter, and an unknown value as an error with the closest one', () => {
    render(<FilterChips filters={[
      { key: 'client', value: 'ludmyla-doula', label: 'Client: Ludmyla Doula', ok: true, message: '', suggestions: [] },
      { key: 'type', value: 'brif', label: 'Type: brif', ok: false, message: "'brif' is not one of its values", suggestions: ['brief'] },
    ]} />)
    const [good, bad] = screen.getAllByRole('listitem')
    expect(good).toHaveTextContent('Client: Ludmyla Doula')
    expect(bad).toHaveTextContent('did you mean brief?')
    expect(bad.className).toContain('text-error')
  })
})
