/**
 * The slash commands of an open chat (features/chat/commands.ts): each one changes the
 * same state as the controls under the message box, or does what its button does.
 */
import { useNavigate } from 'react-router'
import { useProjectStore } from '@/app/projectStore'
import { useProfiles } from '@/features/profiles/api'
import { useModels } from '@/features/providers/api'
import { useProjects } from '@/features/tasks/api'
import { t } from '@/lib/i18n'
import { type Conversation, useBranch, useReasoningEffort, useRegenerate, useUpdateConversation } from './api'
import type { CommandHost, CommandOption } from './commands'
import { EFFORT_LEVELS, canSetEffort } from './reasoning'

type Mode = 'chat' | 'agent'

export interface ChatCommandState {
  conversation: Conversation | undefined
  modelId: string | null
  defaultModelId: string | null
  setModel: (id: string | null) => void
  mode: Mode
  setMode: (mode: Mode) => void
  profileId: string | null
  setProfile: (id: string | null) => void
  /** Whether the last answer can be answered again now (as its Regenerate button). */
  canRetry: boolean
  /** The seq of the last message, to branch after it. */
  lastSeq: number | null
  /** `/compact [focus]`: summarize the chat (sent the way the message box sends it). */
  compact: (focus: string) => Promise<unknown>
}

export function useChatCommands(s: ChatCommandState): CommandHost {
  const navigate = useNavigate()
  const models = useModels().data ?? []
  const profiles = useProfiles().data ?? []
  const projects = useProjects().data ?? []
  const effort = useReasoningEffort()
  const update = useUpdateConversation()
  const branch = useBranch()
  const regenerate = useRegenerate()
  const setProjectId = useProjectStore((p) => p.setProjectId)
  const setView = useProjectStore((p) => p.setView)
  const conv = s.conversation
  const chatModels = models.filter((m) => m.enabled && m.provider_enabled && m.capabilities.chat !== false)
  const current = chatModels.find((m) => m.id === (s.modelId ?? s.defaultModelId))
  const names = [
    'model', 'mode', 'new', 'rename', 'compact', 'voice', 'help',
    ...(canSetEffort(current) ? ['effort'] : []),
    ...(s.mode === 'agent' && profiles.length ? ['permissions'] : []),
    ...(projects.length ? ['project'] : []),
    ...(s.lastSeq !== null ? ['branch'] : []),
    ...(s.canRetry ? ['retry'] : []),
  ]

  const options = (name: string): CommandOption[] => {
    const mark = (on: boolean) => (on ? t('current') : undefined)
    switch (name) {
      case 'model':
        return chatModels.map((m) => ({
          value: m.id,
          label: m.display_name,
          detail: m.id === current?.id ? t('current') : m.id === s.defaultModelId ? t('default') : undefined,
        }))
      case 'effort':
        return EFFORT_LEVELS.map((l) => ({ value: l.id, label: t(l.label), detail: mark(l.id === effort.value) ?? t(l.hint) }))
      case 'mode':
        return [
          { value: 'chat', label: t('Chat'), detail: mark(s.mode === 'chat') },
          { value: 'agent', label: t('Agent'), detail: mark(s.mode === 'agent') },
        ]
      case 'permissions':
        return [
          { value: '', label: t('Default agent'), detail: mark(!s.profileId) },
          ...profiles.map((p) => ({ value: p.id, label: p.name, detail: mark(p.id === s.profileId) })),
        ]
      case 'project':
        return [
          { value: '', label: t('No project'), detail: mark(!conv?.project_id) },
          ...projects.filter((p) => !p.archived).map((p) => ({ value: p.id, label: p.name, detail: mark(p.id === conv?.project_id) })),
        ]
      default:
        return []
    }
  }

  const run = async (name: string, value: string): Promise<string | void> => {
    switch (name) {
      case 'model': {
        s.setModel(value)
        return t('Model: {name}', { name: chatModels.find((m) => m.id === value)?.display_name ?? value })
      }
      case 'effort': {
        effort.set(value as (typeof EFFORT_LEVELS)[number]['id'])
        return t('Reasoning: {level}', { level: t(EFFORT_LEVELS.find((l) => l.id === value)?.label ?? value) })
      }
      case 'mode':
        s.setMode(value === 'agent' ? 'agent' : 'chat')
        return value === 'agent' ? t('Agent mode') : t('Chat mode')
      case 'permissions':
        s.setProfile(value || null)
        return t('Profile: {name}', { name: profiles.find((p) => p.id === value)?.name ?? t('Default agent') })
      case 'project':
        if (!conv) return
        await update.mutateAsync({ id: conv.id, body: { project_id: value || null } })
        return t('Moved to {project}', { project: projects.find((p) => p.id === value)?.name ?? t('No project') })
      case 'rename':
        if (!conv) return
        await update.mutateAsync({ id: conv.id, body: { title: value } })
        return t('Renamed')
      case 'new':
        // The same project, model and mode (the new chat page reads them from the route state).
        if (conv?.project_id) setProjectId(conv.project_id)
        else setView('uncategorized')
        void navigate('/', { state: { modelId: s.modelId, mode: s.mode, profileId: s.profileId } })
        return
      case 'branch': {
        if (!conv || s.lastSeq === null) return
        const copy = await branch.mutateAsync({ conversationId: conv.id, uptoSeq: s.lastSeq })
        void navigate(`/c/${copy.id}`)
        return t('Branched')
      }
      case 'retry':
        if (!conv) return
        await regenerate.mutateAsync({ conversationId: conv.id, modelId: s.modelId })
        return
      case 'compact':
        await s.compact(value)
        return
    }
  }

  return { names, options, run }
}
