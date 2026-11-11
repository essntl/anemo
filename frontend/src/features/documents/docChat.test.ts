import { docChat, setDocChat, withDocument, withoutDocument } from './docChat'

beforeEach(() => localStorage.clear())

describe('the chat remembered for a document', () => {
  it('is none at first, then the one that was set', () => {
    expect(docChat('d1')).toBeNull()
    setDocChat('d1', { chat: 'c1', path: 'documents/a.md' })
    setDocChat('d2', { chat: 'c2', path: 'documents/b.md' })
    expect(docChat('d1')).toEqual({ chat: 'c1', path: 'documents/a.md' })
    expect(docChat('d2')?.chat).toBe('c2')
  })

  it('is forgotten with null, leaving the others', () => {
    setDocChat('d1', { chat: 'c1', path: 'documents/a.md' })
    setDocChat('d2', { chat: 'c2', path: 'documents/b.md' })
    setDocChat('d1', null)
    expect(docChat('d1')).toBeNull()
    expect(docChat('d2')?.chat).toBe('c2')
  })

  it('ignores what is not its own in storage', () => {
    localStorage.setItem('anemo.docChats', '{"d1":"c1"}')
    expect(docChat('d1')).toBeNull()
    localStorage.setItem('anemo.docChats', 'nonsense')
    expect(docChat('d1')).toBeNull()
  })
})

describe('telling the assistant which document a message is about', () => {
  it('puts the title and the file before the message, and takes them off again', () => {
    const sent = withDocument('Make the intro shorter.', 'Trip plan', 'documents/travel/trip-plan.md')
    expect(sent).toContain('“Trip plan” (documents/travel/trip-plan.md)')
    expect(sent.endsWith('\n\nMake the intro shorter.')).toBe(true)
    expect(withoutDocument(sent)).toBe('Make the intro shorter.')
  })

  it('keeps a message of several paragraphs whole', () => {
    const text = 'First.\n\nSecond.'
    expect(withoutDocument(withDocument(text, 'A “quoted” title', 'documents/a.md'))).toBe(text)
  })

  it('leaves a message alone that only looks similar', () => {
    const similar = [
      'About my document “X” is a strange sentence.',
      'Plain message',
      'About my document “X”\n\nIt is open beside this chat: when I ask for a change, edit that file.\n\nmore',
    ]
    for (const text of similar) expect(withoutDocument(text)).toBe(text)
  })
})
