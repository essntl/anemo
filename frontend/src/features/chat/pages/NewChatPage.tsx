import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Loader2, MessageSquare, Timer } from 'lucide-react'
import { api, errorMessage, unwrap } from '@/api/client'
import { inScope, useScope } from '@/app/projectStore'
import { PageHeader } from '@/components/ui/PageHeader'
import { type Mode, ModeSwitch } from '@/features/agents/components/ModeSwitch'
import { useSlashSkills } from '@/features/profiles/api'
import { ProfilePicker } from '@/features/profiles/components/ProfilePicker'
import { useSetupStatus } from '@/features/providers/api'
import { useSettings } from '@/features/settings/api'
import { ShortcutKeys } from '@/features/shortcuts/ShortcutKeys'
import { SkillIcon } from '@/features/skills/icons'
import { useTasks } from '@/features/tasks/api'
import { bucketOf, formatDue } from '@/features/tasks/dates'
import { cn } from '@/lib/cn'
import { formatWhen } from '@/lib/format'
import { rich, t } from '@/lib/i18n'
import { conversationKey, conversationsKey, createConversation, messagesKey, useConversations } from '../api'
import { Composer, type ComposerHandle } from '../components/Composer'
import { ModelPicker } from '../components/ModelPicker'

const PANEL = 'rounded-card bg-card p-2 shadow-soft'
const PANEL_TITLE = 'flex h-8 items-center px-2 text-[12px] font-semibold'
const ROW = 'flex min-h-10 items-center gap-2.5 rounded-control px-2 text-[13.5px] hover:bg-surface-hover pointer-coarse:min-h-12'

/**
 * Under the message box: the chats last talked in, the skills to start a message with,
 * and the tasks that are due, all for what the sidebar's switcher shows. Each part is
 * left out while it has nothing in it.
 */
function Starters({ onSkill }: { onSkill: (skill: ReturnType<typeof useSlashSkills>[number]) => void }) {
  const scope = useScope()
  const chats = useConversations('', scope.kind === 'project' ? { projectId: scope.project.id, limit: 4 } : { noProject: scope.kind === 'uncategorized', limit: 4 })
  const skills = useSlashSkills().slice(0, 6)
  const tasks = useTasks()
  const recent = (chats.data ?? []).slice(0, 4)
  const due = (tasks.data ?? [])
    .filter((t) => t.status !== 'done' && t.status !== 'cancelled' && inScope(scope, t.project_id))
    .filter((t) => ['overdue', 'today'].includes(bucketOf(t)))
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
    .slice(0, 3)
  if (!recent.length && !skills.length && !due.length) return null
  const overdueLabel = t('Overdue')
  return (
    // grid-cols-1: the one column is as wide as the page, however long a chat's title is.
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {recent.length > 0 && (
        <section className={cn(PANEL, 'min-w-0')} aria-label={t('Recent chats')}>
          <div className={PANEL_TITLE}>
            <span className="flex-1">{t('Pick up where you left off')}</span>
            <Link to="/chats" className="font-medium text-accent hover:underline">{t('All chats')}</Link>
          </div>
          {recent.map((c) => (
            <Link key={c.id} to={`/c/${c.id}`} className={ROW}>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                {c.active_run_id ? <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" /> : <MessageSquare className="h-3.5 w-3.5" />}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{c.title}</span>
              <span className="shrink-0 text-[12px] text-subtle">{c.active_run_id ? t('Working') : formatWhen(c.last_message_at)}</span>
            </Link>
          ))}
        </section>
      )}
      <div className="flex min-w-0 flex-col gap-3">
        {skills.length > 0 && (
          <section className={PANEL} aria-label={t('Skills')}>
            <div className={PANEL_TITLE}>
              <span className="flex-1">{t('Start with a skill')}</span>
              <Link to="/settings/skills" className="font-medium text-accent hover:underline">{t('Manage')}</Link>
            </div>
            <div className="flex flex-wrap gap-1.5 px-2 pb-2 pt-0.5">
              {skills.map((s) => (
                <button key={s.id} type="button" title={s.hint || s.description} onClick={() => onSkill(s)}
                  className="flex h-8 items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 text-[13px] font-medium hover:bg-surface-hover pointer-coarse:h-10 [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:text-muted">
                  <SkillIcon name={s.icon} /> {s.name}
                </button>
              ))}
            </div>
          </section>
        )}
        {due.length > 0 && (
          <section className={PANEL} aria-label={t('Tasks due')}>
            <div className={PANEL_TITLE}>
              <span className="flex-1">{t('Due')}</span>
              <Link to="/tasks" className="font-medium text-accent hover:underline">{t('Tasks')}</Link>
            </div>
            {due.map((t) => {
              const overdue = bucketOf(t) === 'overdue'
              return (
                <Link key={t.id} to={`/tasks?task=${t.id}`} className={ROW}>
                  <span aria-hidden className={cn('h-4 w-4 shrink-0 rounded-full border-2', overdue ? 'border-error' : 'border-border-strong')} />
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <span className={cn('shrink-0 text-[12px]', overdue ? 'font-medium text-error' : 'text-subtle')}>{overdue ? overdueLabel : formatDue(t)}</span>
                </Link>
              )
            })}
          </section>
        )}
      </div>
    </div>
  )
}

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
  const scope = useScope()
  const project = scope.kind === 'project' ? scope.project : null
  const [profileOverride, setProfileId] = useState<string | null | undefined>(undefined)
  const profileId = profileOverride !== undefined ? profileOverride : (project?.default_profile_id ?? null)
  // A temporary chat is deleted five minutes after its last message (?temporary=1 starts one).
  const [temporary, setTemporary] = useState(params.get('temporary') === '1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const composer = useRef<ComposerHandle>(null)

  const start = async (text: string, attachmentIds: string[], referenceIds: string[], skillId: string | null) => {
    setBusy(true)
    setError(null)
    try {
      const conv = await createConversation(modelId, project?.id ?? null, temporary)
      const turn = unwrap(
        await api.POST('/api/conversations/{conversation_id}/turns', {
          params: { path: { conversation_id: conv.id } },
          body: {
            text, model_id: modelId, attachment_ids: attachmentIds, reference_ids: referenceIds, mode, profile_id: profileId, skill_id: skillId,
          },
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
      throw err // the composer puts the message back
    }
  }

  const needsSetup = setup.data && !setup.data.has_chat_default

  return (
    // Phones: the heading and the starters scroll, the message box stays at the bottom
    // within thumb reach. From `md` up: the box sits under the heading, the starters under it.
    <div className="flex h-full flex-col px-2 pb-2 md:items-center md:overflow-y-auto md:px-6 md:pb-8">
      <PageHeader title={t('New chat')} />
      <div className="flex min-h-0 w-full max-w-3xl flex-1 flex-col md:flex-none md:pt-[9vh]">
        <div className="px-2 pt-3 md:mb-4 md:px-1 md:pt-0">
          <h2 className="text-[24px] font-bold leading-tight tracking-tight md:text-[30px]">{temporary ? t('Temporary chat') : t('What do you need done?')}</h2>
          {temporary && (
            <p className="mt-1.5 max-w-md text-[13.5px] text-muted">
              {t('Deleted 5 minutes after the last message, unless you keep it. Nothing is remembered from it.')}
            </p>
          )}
          {project && (
            <p className="mt-1.5 flex items-center gap-1.5 text-[13.5px] text-muted">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: project.color }} />
              {rich('New chat in <b>{name}</b>', { b: () => <span className="font-medium text-text">{project.name}</span> })}
            </p>
          )}
          {needsSetup && (
            <p className="mt-1.5 text-[13.5px] text-muted">
              {rich('First, <a>connect a provider and pick a default model</a>.', { a: (c) => <Link to="/settings/providers" className="text-accent underline">{c}</Link> })}
            </p>
          )}
        </div>
        <div className="order-2 shrink-0 md:order-1">
          {error && <p className="mb-2 text-center text-[13px] text-error">{error}</p>}
          <Composer
            handle={composer}
            running={false}
            disabled={busy || Boolean(needsSetup)}
            initialText={aboutDoc ? `About my document “${params.get('title') ?? aboutDoc}” (${aboutDoc}): ` : undefined}
            onSend={start}
            // Skills that need tools (e.g. web search for /fact-check) switch to Agent mode.
            onSkillChange={(skill) => skill?.mode === 'agent' && setModeOverride('agent')}
            toolbar={
              <>
                <ModeSwitch mode={mode} onChange={setModeOverride} profileId={profileId} />
                {mode === 'agent' && <ProfilePicker value={profileId} onChange={setProfileId} />}
                <ModelPicker value={modelId} defaultModelId={project?.default_model_id ?? settings.data?.models.chat ?? null} onChange={setModelId} />
                <button type="button" aria-pressed={temporary} aria-label={t('Temporary chat')} onClick={() => setTemporary(!temporary)}
                  title={t('Temporary chat: deleted 5 minutes after the last message')}
                  className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors pointer-coarse:h-10 pointer-coarse:w-10',
                    temporary ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-text')}>
                  <Timer className="h-4 w-4" />
                </button>
              </>
            }
          />
          <p className="mt-2 hidden items-center justify-center gap-4 text-[12px] text-subtle md:flex pointer-coarse:hidden">
            <span className="flex items-center gap-1.5"><ShortcutKeys id="chat.send" /> {t('send')}</span>
            <span className="flex items-center gap-1.5"><ShortcutKeys id="chat.newline" /> {t('new line')}</span>
            <span className="flex items-center gap-1.5"><ShortcutKeys id="chat.skill" /> {t('skills')}</span>
          </p>
        </div>
        <div className="order-1 min-h-0 flex-1 overflow-y-auto px-1 py-3 md:order-2 md:mt-5 md:flex-none md:overflow-visible md:px-0 md:py-0">
          <Starters onSkill={(skill) => composer.current?.useSkill(skill)} />
        </div>
      </div>
    </div>
  )
}
