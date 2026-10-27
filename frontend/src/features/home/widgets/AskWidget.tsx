import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { ArrowUp, Bot, MessageSquare, Sparkles } from 'lucide-react'
import { api, errorMessage, unwrap } from '@/api/client'
import { useCurrentProject } from '@/app/projectStore'
import { conversationKey, conversationsKey, createConversation, messagesKey } from '@/features/chat/api'
import { useModels } from '@/features/providers/api'
import { useSettings } from '@/features/settings/api'
import { WidgetHeader } from './parts'

/** Ask Anemo: one line; Enter starts a new chat (in the chosen project) with it. */
export function AskWidget() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const settings = useSettings()
  const models = useModels()
  const project = useCurrentProject()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mode = settings.data?.general.default_chat_mode ?? 'chat'
  const modelId = project?.default_model_id ?? settings.data?.models.chat ?? null
  const model = models.data?.find((m) => m.id === modelId)

  const ask = async () => {
    const message = text.trim()
    if (!message || busy) return
    setBusy(true)
    setError(null)
    try {
      const conv = await createConversation(null, project?.id ?? null)
      const turn = unwrap(
        await api.POST('/api/conversations/{conversation_id}/turns', {
          params: { path: { conversation_id: conv.id } },
          body: { text: message, model_id: null, attachment_ids: [], reference_ids: [], mode, profile_id: project?.default_profile_id ?? null },
        }),
      )
      qc.setQueryData(conversationKey(conv.id), { ...conv, active_run_id: turn.run_id })
      qc.setQueryData(messagesKey(conv.id), [turn.user_message, turn.assistant_message].filter(Boolean))
      void qc.invalidateQueries({ queryKey: conversationsKey })
      void navigate(`/c/${conv.id}`)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <>
      <WidgetHeader title="Ask Anemo" icon={<Sparkles />}>
        <span className="flex max-w-[60%] items-center gap-1 truncate rounded-full bg-surface-2 px-2.5 py-1 text-[11.5px] text-muted"
          title="What will answer (change the defaults in Settings)">
          {mode === 'agent' ? <Bot className="h-3 w-3 shrink-0" /> : <MessageSquare className="h-3 w-3 shrink-0" />}
          <span className="truncate">{mode === 'agent' ? 'Agent' : 'Chat'}{model ? ` · ${model.display_name}` : ''}{project ? ` · ${project.name}` : ''}</span>
        </span>
      </WidgetHeader>
      <form className="flex flex-1 flex-col justify-center px-4 pb-4" onSubmit={(e) => { e.preventDefault(); void ask() }}>
        <div className="flex items-center gap-2 rounded-card border border-border bg-surface px-3 py-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask anything…" aria-label="Ask Anemo"
            enterKeyHint="send" className="h-9 min-w-0 flex-1 bg-transparent text-[14px] placeholder:text-subtle focus:outline-none" />
          <button type="submit" aria-label="Ask" disabled={!text.trim() || busy}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-contrast disabled:opacity-40 pointer-coarse:h-10 pointer-coarse:w-10">
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
        {error && <p role="alert" className="mt-1.5 text-[12.5px] text-error">{error}</p>}
      </form>
    </>
  )
}
