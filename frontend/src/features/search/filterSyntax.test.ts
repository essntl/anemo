import { describe, expect, it } from 'vitest'
import type { PropertyDefinition } from '@/features/properties/api'
import { completeFilter, typingFilter } from './filterSyntax'

const client = { key: 'client', type: 'select', options: [] } as unknown as PropertyDefinition
const notes = { key: 'notes', type: 'text', options: [] } as unknown as PropertyDefinition

describe('typing a filter', () => {
  it('notices a property with values being typed at the end', () => {
    expect(typingFilter('price client:lud', [client])).toEqual({ definition: client, partial: 'lud' })
    expect(typingFilter('client:', [client])?.partial).toBe('')
    expect(typingFilter('client:acme price', [client])).toBeNull() // already done
    expect(typingFilter('notes:x', [notes])).toBeNull() // no values to suggest
    expect(typingFilter('at 10:3', [client])).toBeNull()
  })
  it('completes it with the chosen value', () => {
    expect(completeFilter('price client:lud', 'ludmyla-doula')).toBe('price client:ludmyla-doula ')
    expect(completeFilter('client:"Lud', 'ludmyla-doula')).toBe('client:ludmyla-doula ')
  })
})
