import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Sparkles } from 'lucide-react'
import { api, errorMessage, unwrap } from '@/api/client'
import { useCurrentProject } from '@/app/projectStore'
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
  // "Ask the assistant" on a document opens a new chat about it: the agent can read
  // (and, if allowed, edit) the file, so Agent mode is preselected.
  const [params] = useSearchParams()
  const aboutDoc = params.get('doc')
  const mode: Mode = modeOverride ?? (aboutDoc ? 'agent' : (settings.data?.general.default_chat_mode ?? 'chat'))
  // A chat started while a project is chosen belongs to it, and starts with its defaults.
  const project = useCurrentProject()
  const [profileOverride, setProfileId] = useState<string | null | undefined>(undefined)
  const profileId = profileOverride !== undefined ? profileOverride : (project?.default_profile_id ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async (text: string, attachmentIds: string[], referenceIds: string[]) => {
    setBusy(true)
    setError(null)
    try {
      const conv = await createConversation(modelId, project?.id ?? null)
      const turn = unwrap(
        await api.POST('/api/conversations/{conversation_id}/turns', {
          params: { path: { conversation_id: conv.id } },
          body: { text, model_id: modelId, attachment_ids: attachmentIds, reference_ids: referenceIds, mode, profile_id: profileId },
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
          {project && (
            <p className="mt-2 flex items-center gap-1.5 text-[13px] text-muted">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: project.color }} />
              New chat in <span className="font-medium text-text">{project.name}</span>
            </p>
          )}
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
          initialText={aboutDoc ? `About my document “${params.get('title') ?? aboutDoc}” (${aboutDoc}): ` : undefined}
          onSend={start}
          toolbar={
            <>
              <ModeSwitch mode={mode} onChange={setModeOverride} profileId={profileId} />
              {mode === 'agent' && <ProfilePicker value={profileId} onChange={setProfileId} />}
              <ModelPicker value={modelId} defaultModelId={project?.default_model_id ?? settings.data?.models.chat ?? null} onChange={setModelId} />
            </>
          }
        />
      </div>
    </div>
  )
}
