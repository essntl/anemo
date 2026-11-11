/**
 * The chat beside a document: which chat it is (remembered on this device), and the line
 * that tells the assistant which file the chat is about.
 */

/** Browser storage: per document, its chat and the file path that chat was told. */
const CHATS = 'anemo.docChats'

export interface DocChat {
  chat: string
  /** The document's path when the assistant was last told it (it changes on a rename or move). */
  path: string
}

function all(): Record<string, DocChat> {
  try {
    const value = JSON.parse(localStorage.getItem(CHATS) ?? '{}') as unknown
    return value && typeof value === 'object' ? (value as Record<string, DocChat>) : {}
  } catch {
    return {}
  }
}

export function docChat(documentId: string): DocChat | null {
  const found = all()[documentId] as Partial<DocChat> | undefined
  return found && typeof found.chat === 'string' && typeof found.path === 'string' ? { chat: found.chat, path: found.path } : null
}

/** Remembers the document's chat; `null` forgets it (the chat itself stays in the chat list). */
export function setDocChat(documentId: string, value: DocChat | null): void {
  try {
    const next = all()
    if (value) next[documentId] = value
    else delete next[documentId]
    localStorage.setItem(CHATS, JSON.stringify(next))
  } catch {
    // No storage (private mode): the chat is found again in the chat list.
  }
}

const LEAD = 'About my document “'
const TAIL = 'It is open beside this chat: when I ask for a change, edit that file.'

/** The message with a first paragraph that says which document it is about. */
export function withDocument(text: string, title: string, path: string): string {
  return `${LEAD}${title.replace(/\s+/g, ' ')}” (${path}). ${TAIL}\n\n${text}`
}

/** The message as it was typed: without the paragraph `withDocument` put before it. */
export function withoutDocument(text: string): string {
  if (!text.startsWith(LEAD)) return text
  const end = text.indexOf(`${TAIL}\n\n`)
  // Only the first paragraph can be it.
  return end === -1 || text.slice(0, end).includes('\n') ? text : text.slice(end + TAIL.length + 2)
}
