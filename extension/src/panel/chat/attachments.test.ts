import { describe, expect, it } from 'vitest'
import { formatSize, MAX_BYTES, refusal } from './attachments'
import { findRanges } from './find'

describe('attachments', () => {
  it('refuses what Anemo would refuse, before uploading', () => {
    expect(refusal({ size: 10 }, 0)).toBeNull()
    expect(refusal({ size: MAX_BYTES }, 9)).toBeNull()
    expect(refusal({ size: MAX_BYTES + 1 }, 0)).toBe('Larger than 25 MB.')
    expect(refusal({ size: 10 }, 10)).toBe('A message takes at most 10 files.')
    expect(refusal({ size: 0 }, 0)).toBe('The file is empty.')
    expect([formatSize(900), formatSize(2048), formatSize(3 * 1024 * 1024)]).toEqual(['900 B', '2 KB', '3.0 MB'])
  })
})

describe('find in chat', () => {
  it('finds every occurrence across elements, ignoring case', () => {
    document.body.innerHTML = '<div id="c"><p>Apples and <b>apples</b></p><p>pineAPPLES</p></div>'
    const ranges = findRanges(document.getElementById('c')!, 'apples')
    expect(ranges.map((r) => r.toString())).toEqual(['Apples', 'apples', 'APPLES'])
    expect(findRanges(document.body, '  ')).toEqual([])
  })
})
