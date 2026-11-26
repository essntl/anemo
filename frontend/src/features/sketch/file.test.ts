import { describe, expect, it } from 'vitest'
import { sketchFromFile } from './file'

const FILE = [
  '---', 'client: acme', '---', '# Board', '', '## Transcription', '<!-- anemo:transcription drawing=abc -->', 'Hello', '',
  '````anemo-sketch',
  '{"v":1,"layout":"pages","background":"grid","pages":2,"items":[{"type":"text","id":"t1","color":"ink","x":1,"y":2,"size":18,"text":"Hi"}]}',
  '````', '',
].join('\n')

describe('a sketch file of an earlier version', () => {
  it('gives its drawing', () => {
    const data = sketchFromFile(FILE)
    expect(data?.layout).toBe('pages')
    expect(data?.pages).toBe(2)
    expect(data?.items).toHaveLength(1)
  })

  it('gives nothing when there is no drawing that can be read', () => {
    expect(sketchFromFile('# Just text\n')).toBeNull()
    expect(sketchFromFile('````anemo-sketch\n{not json\n````\n')).toBeNull()
    expect(sketchFromFile('````anemo-sketch\n{"v":1}\n````\n')).toBeNull()
  })
})
