import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
import { Sparkles } from 'lucide-react'
import { api, errorMessage, unwrap } from '@/api/client'
import { useSetupStatus } from '@/features/providers/api'
import { useSettings } from '@/features/settings/api'
import { conversationKey, conversationsKey, createConversation, messagesKey } from '../api'
import { Composer } from '../components/Composer'
import { ModelPicker } from '../components/ModelPicker'

export function NewChatPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const settings = useSettings()
  const setup = useSetupStatus()
  const [modelId, setModelId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async (text: string) => {
    setBusy(true)
    setError(null)
    try {
      const conv = await createConversation(modelId)
      const turn = unwrap(
        await api.POST('/api/conversations/{conversation_id}/turns', {
          params: { path: { conversation_id: conv.id } },
          body: { text, model_id: modelId },
        }),
      )
      // Seed the cache so the conversation page renders instantly and starts streaming.
      qc.setQueryData(conversationKey(conv.id), { ...conv, active_run_id: turn.run_id })
      qc.setQueryData(messagesKey(conv.id), [turn.user_message, turn.assistant_message].filter(Boolean))
      void qc.invalidateQueries({ queryKey: conversationsKey })
      navigate(`/c/${conv.id}`)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const needsSetup = setup.data && !setup.data.has_chat_default

  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <div className="w-full max-w-3xl">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <Sparkles className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-semibold">How can I help today?</h1>
          {needsSetup && (
            <p className="mt-2 text-[13px] text-muted">
              First, <Link to="/settings/providers" className="text-accent underline">connect a provider and pick a default model</Link>.
            </p>
          )}
        </div>
        {error && <p className="mb-2 text-center text-[13px] text-error">{error}</p>}
        <Composer
          running={false}
          disabled={busy || Boolean(needsSetup)}
          onSend={start}
          toolbar={
            <ModelPicker value={modelId} defaultModelId={settings.data?.models.chat ?? null} onChange={setModelId} />
          }
        />
      </div>
    </div>
  )
}
