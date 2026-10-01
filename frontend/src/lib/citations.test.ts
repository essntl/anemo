import { stripCitationMarkup } from './citations'

describe('stripCitationMarkup', () => {
  it('removes complete and half-streamed citation markup', () => {
    expect(stripCitationMarkup('Doubtful. citeturn0search3turn0search2\n')).toBe('Doubtful. \n')
    expect(stripCitationMarkup('Doubtful. citeturn0sea')).toBe('Doubtful. ')
    expect(stripCitationMarkup('plain [link](https://x.example)')).toBe('plain [link](https://x.example)')
  })
})
