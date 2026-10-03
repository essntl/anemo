import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Sparkles, Timer } from 'lucide-react'
import { api, errorMessage, unwrap } from '@/api/client'
import { useCurrentProject } from '@/app/projectStore'
import { type Mode, ModeSwitch } from '@/features/agents/components/ModeSwitch'
import { ProfilePicker } from '@/features/profiles/components/ProfilePicker'
import { useSetupStatus } from '@/features/providers/api'
import { useSettings } from '@/features/settings/api'
import { cn } from '@/lib/cn'
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
  // A temporary chat is deleted five minutes after its last message (?temporary=1 starts one).
  const [temporary, setTemporary] = useState(params.get('temporary') === '1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async (text: string, attachmentIds: string[], referenceIds: string[]) => {
    setBusy(true)
    setError(null)
    try {
      const conv = await createConversation(modelId, project?.id ?? null, temporary)
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
          <div className={cn('mb-4 flex h-12 w-12 items-center justify-center rounded-2xl text-accent',
            temporary ? 'border-2 border-dashed border-accent/60' : 'bg-accent-soft')}>
            {temporary ? <Timer className="h-6 w-6" /> : <Sparkles className="h-6 w-6" />}
          </div>
          <h1 className="text-xl font-semibold md:text-2xl">{temporary ? 'Temporary chat' : 'How can I help today?'}</h1>
          {temporary && (
            <p className="mt-2 max-w-sm text-[13px] text-muted">
              Deleted 5 minutes after the last message, unless you keep it. Nothing is remembered from it.
            </p>
          )}
          <button type="button" aria-pressed={temporary} onClick={() => setTemporary(!temporary)}
            className={cn('mt-3 flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors pointer-coarse:h-10',
              temporary ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:border-border-strong hover:text-text')}>
            <Timer className="h-3.5 w-3.5" /> Temporary chat
          </button>
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
