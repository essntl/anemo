import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
import { Sparkles } from 'lucide-react'
import { api, errorMessage, unwrap } from '@/api/client'
import { type Mode, ModeSwitch } from '@/features/agents/components/ModeSwitch'
import { ProfilePicker } from '@/features/profiles/components/ProfilePicker'
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
  const [modeOverride, setModeOverride] = useState<Mode | null>(null)
  const mode: Mode = modeOverride ?? settings.data?.general.default_chat_mode ?? 'chat'
  const [profileId, setProfileId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async (text: string, attachmentIds: string[]) => {
    setBusy(true)
    setError(null)
    try {
      const conv = await createConversation(modelId)
      const turn = unwrap(
        await api.POST('/api/conversations/{conversation_id}/turns', {
          params: { path: { conversation_id: conv.id } },
          body: { text, model_id: modelId, attachment_ids: attachmentIds, mode, profile_id: profileId },
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
    // Phones: greeting centered, composer at the bottom within thumb reach.
    // From `md` up: both centered together.
    <div className="flex h-full flex-col px-2 pb-2 md:items-center md:justify-center md:px-6 md:pb-0">
      <div className="flex w-full max-w-3xl flex-1 flex-col md:flex-none">
        <div className="flex flex-1 flex-col items-center justify-center px-4 text-center md:mb-8 md:flex-none">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <Sparkles className="h-6 w-6" />
          </div>
          <h1 className="text-xl font-semibold md:text-2xl">How can I help today?</h1>
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
            <>
              <ModeSwitch mode={mode} onChange={setModeOverride} profileId={profileId} />
              {mode === 'agent' && <ProfilePicker value={profileId} onChange={setProfileId} />}
              <ModelPicker value={modelId} defaultModelId={settings.data?.models.chat ?? null} onChange={setModelId} />
            </>
          }
        />
      </div>
    </div>
  )
}
