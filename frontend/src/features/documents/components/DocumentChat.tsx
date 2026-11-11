import { useCallback, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { createConversation } from '@/features/chat/api'
import { SideChat } from '@/features/chat/components/SideChat'
import { msg, t } from '@/lib/i18n'
import { docChat, setDocChat, type DocChat, withDocument, withoutDocument } from '../docChat'

/** Ways to begin: what the button says, and the message it sends. */
const STARTERS = [
  [msg('Fix spelling and grammar'), msg('Fix the spelling and grammar in this document. Change nothing else.')],
  [msg('Make it shorter and clearer'), msg('Make this document shorter and clearer, without losing anything that matters.')],
  [msg('Suggest a better structure'), msg('Suggest a better structure for this document. Don’t change it yet: tell me what you would move, and why.')],
] as const

/**
 * A chat with the assistant beside a document, to have it changed without leaving the
 * page. The assistant is told which file it is and edits it itself; the editor shows the
 * new text when it is saved, and the notice above offers to review or undo it.
 *
 * `save` stores what is being typed first, so the assistant reads what you see; it
 * resolves to false when that could not be saved.
 */
export function DocumentChat({ documentId, title, path, projectId, save }: {
  documentId: string
  title: string
  path: string
  /** The project whose folder the document is in, if any: the chat is made in it. */
  projectId: string | null
  save: () => Promise<boolean>
}) {
  const [link, setLink] = useState<DocChat | null>(() => docChat(documentId))
  const remember = useCallback((next: DocChat | null) => {
    setDocChat(documentId, next)
    setLink(next)
  }, [documentId])
  const forget = useCallback(() => remember(null), [remember])

  const prepare = async (text: string, first: boolean) => {
    if (!(await save())) throw new Error(t('The document has changes that could not be saved. Sort that out first, so the assistant reads what you see.'))
    // Said with the first message, and again after the file was renamed or moved.
    if (!first && link?.path === path) return text
    if (!first && link) remember({ ...link, path })
    return withDocument(text, title, path)
  }

  return (
    <SideChat
      conversationId={link?.chat ?? null}
      create={() => createConversation(null, projectId)}
      onCreated={(conversation) => remember({ chat: conversation.id, path })}
      onRestart={forget}
      onGone={forget}
      prepare={prepare}
      display={withoutDocument}
      placeholder={t('Ask for a change…')}
      empty={(ask) => (
        <div className="flex flex-col gap-3 p-4">
          <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-control bg-accent-soft text-accent"><Sparkles className="h-4 w-4" /></span>
          <div>
            <h3 className="text-[14px] font-semibold">{t('Edit with the assistant')}</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              {t('Say what should change. The assistant edits this document itself, and you can review or undo what it did.')}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            {STARTERS.map(([label, message]) => (
              <button key={label} type="button" onClick={() => ask(t(message))}
                className="flex min-h-9 items-center rounded-control border border-border bg-surface px-3 py-1.5 text-left text-[13px] font-medium hover:bg-surface-hover pointer-coarse:min-h-11">
                {t(label)}
              </button>
            ))}
          </div>
        </div>
      )}
    />
  )
}
