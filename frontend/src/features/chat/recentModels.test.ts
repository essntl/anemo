import { beforeEach, describe, expect, it } from 'vitest'
import { recentModels, rememberModel, shortlist } from './recentModels'

const MODELS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id }))
const ids = (list: { id: string }[]) => list.map((m) => m.id)

beforeEach(() => localStorage.clear())

describe('the models shown first', () => {
  it('are the one in use, the default and the ones chosen last, in the order of the full list', () => {
    rememberModel('f')
    rememberModel('g')
    expect(ids(shortlist(MODELS, 'e', 'c'))).toEqual(['c', 'e', 'f', 'g'])
  })

  it('are filled up from the start of the list', () => {
    expect(ids(shortlist(MODELS, 'e', null))).toEqual(['a', 'b', 'c', 'e'])
    expect(ids(shortlist(MODELS.slice(0, 2), null, null))).toEqual(['a', 'b'])
  })

  it('leave out a remembered model that is no longer there', () => {
    rememberModel('gone')
    expect(ids(shortlist(MODELS, 'a', 'a'))).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('the models chosen last', () => {
  it('are kept newest first, each once, six at most', () => {
    for (const id of ['a', 'b', 'a', 'c', 'd', 'e', 'f', 'g']) rememberModel(id)
    expect(recentModels()).toEqual(['g', 'f', 'e', 'd', 'c', 'a'])
  })

  it('are empty when what is stored is not a list', () => {
    localStorage.setItem('anemo.chat.recentModels', '{"x":1}')
    expect(recentModels()).toEqual([])
  })
})
