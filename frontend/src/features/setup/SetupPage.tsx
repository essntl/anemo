/**
 * The first-run setup (`/setup`): a model provider, helper models, time zone and start
 * page, the optional parts, and notifications. Offered when Anemo is opened and nothing
 * is set up yet; reopened from Settings > Advanced. Every step can be skipped, and
 * where it was left is kept on the server, so another device continues there. It uses
 * the same settings and dialogs as the Settings pages: nothing it sets differs from
 * setting it there.
 */
import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { Bell, Boxes, Clock, Cpu, Plug, Plus, RefreshCw, Rocket } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, Input } from '@/components/ui/Input'
import { Lingering } from '@/components/ui/Lingering'
import { Select } from '@/components/ui/Select'
import { toast } from '@/components/ui/toast'
import { type Destination, useDestinations } from '@/features/notifications/api'
import { DestinationDialog } from '@/features/notifications/components/DestinationDialog'
import { PushCard } from '@/features/notifications/NotificationSettingsPage'
import { type ModelDefaults, useModels, useProviders, useSaveModelDefaults } from '@/features/providers/api'
import { ProviderCard } from '@/features/providers/components/ProviderCard'
import { ProviderDialog } from '@/features/providers/components/ProviderDialog'
import { type AllSettings, useSaveGeneral, useSaveSection, useSettings } from '@/features/settings/api'
import { CheckRow } from '@/features/settings/CheckRow'
import { useSystemStatus } from '@/features/settings/systemStatus'
import { cn } from '@/lib/cn'
import { deviceTimeZone, modelsFor, neighbour, startStep, STEPS, type StepId, suggestHelpers } from './steps'

const ICONS: Record<StepId, ReactNode> = {
  provider: <Plug />,
  models: <Cpu />,
  you: <Clock />,
  parts: <Boxes />,
  notifications: <Bell />,
}

interface Nav {
  step: StepId
  back: (() => void) | null
  /** To the next step, or finish after the last one. */
  next: () => void
  last: boolean
}

/** Back, Skip and Next (Finish on the last step). Next first saves what the step changed. */
function StepFooter({ nav, onNext, busy, error }: { nav: Nav; onNext?: () => Promise<unknown>; busy?: boolean; error?: unknown }) {
  const [saving, setSaving] = useState(false)
  const optional = STEPS.find((s) => s.id === nav.step)?.optional
  const next = async () => {
    if (onNext) {
      setSaving(true)
      try {
        await onNext()
      } catch {
        setSaving(false)
        return // the step shows the error
      }
      setSaving(false)
    }
    nav.next()
  }
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      {error != null && <p className="text-[13px] text-error">{errorMessage(error)}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {nav.back && <Button variant="ghost" onClick={nav.back}>Back</Button>}
        <div className="flex-1" />
        {optional && !nav.last && <Button variant="ghost" onClick={nav.next}>Skip</Button>}
        <Button variant="primary" loading={saving || busy} onClick={() => void next()}>
          {nav.last ? 'Finish' : 'Next'}
        </Button>
      </div>
    </div>
  )
}

function Intro({ children }: { children: ReactNode }) {
  return <p className="text-[13.5px] text-muted">{children}</p>
}

// -- 1. provider ---------------------------------------------------------------------

function ProviderStep({ nav, defaults }: { nav: Nav; defaults: ModelDefaults }) {
  const providers = useProviders()
  const models = useModels()
  const save = useSaveModelDefaults()
  const [adding, setAdding] = useState(false)
  const [chat, setChat] = useState(defaults.chat ?? null)
  const all = models.data ?? []
  const chatModels = modelsFor('chat', all)

  return (
    <>
      <Intro>
        Anemo answers with the models of a provider you connect: OpenAI, Anthropic, OpenRouter, a server of your own
        such as Ollama, or your Claude subscription. Keys are encrypted and stay on your server. Add one, use
        <em> Add models</em> to pick its models, then choose the model for chats.
      </Intro>
      <div className="flex flex-col gap-3">
        {providers.data?.map((p) => (
          <ProviderCard key={p.id} provider={p} models={all.filter((m) => m.provider_id === p.id)} />
        ))}
        <div>
          <Button variant={providers.data?.length ? 'secondary' : 'primary'} icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
            {providers.data?.length ? 'Add another provider' : 'Add provider'}
          </Button>
        </div>
      </div>
      {chatModels.length > 0 && (
        <Field label="Model for chats" hint="Other kinds of work use it too, unless you choose otherwise in the next step.">
          <Select aria-label="Model for chats" value={chat ?? ''} onValueChange={(v) => setChat(v || null)}
            options={[{ value: '', label: 'Not set' }, ...chatModels.map((m) => ({ value: m.id, label: `${m.display_name} — ${m.provider_name}` }))]} />
        </Field>
      )}
      <StepFooter nav={nav} error={save.error}
        onNext={chat !== (defaults.chat ?? null) ? () => save.mutateAsync({ ...defaults, chat }) : undefined} />
      <Lingering value={adding}>{() => <ProviderDialog open onOpenChange={setAdding} />}</Lingering>
    </>
  )
}

// -- 2. helper models ----------------------------------------------------------------

const HELPERS: { key: 'summarization' | 'memory' | 'embeddings'; label: string; hint: string }[] = [
  { key: 'summarization', label: 'Summaries', hint: 'Shortens long conversations so agents keep working. A small, fast model is ideal.' },
  { key: 'memory', label: 'Memory', hint: 'Notices facts and preferences in your chats worth remembering.' },
  { key: 'embeddings', label: 'Embeddings', hint: 'Finds memories and documents by meaning, not only by their words.' },
]

function ModelsStep({ nav, defaults }: { nav: Nav; defaults: ModelDefaults }) {
  const models = useModels()
  const save = useSaveModelDefaults()
  const all = models.data ?? []
  const [form, setForm] = useState(() => suggestHelpers(all, defaults))
  const ready = models.isSuccess
  // The suggestions need the models; they arrive after the first render on a fresh page.
  const [seeded, setSeeded] = useState(ready)
  if (ready && !seeded) {
    setSeeded(true)
    setForm(suggestHelpers(all, defaults))
  }
  const changed = HELPERS.some((h) => (form[h.key] ?? null) !== (defaults[h.key] ?? null))

  return (
    <>
      <Intro>
        Some work happens in the background. It can use smaller, cheaper models than chats; the suggestions come from
        the models you added. Leave one on <em>Use chat model</em> to share the chat model.
      </Intro>
      {ready && all.length === 0 && (
        <p className="text-[13px] text-muted">No models yet: add a provider and its models first. You can set these later in Settings → Providers &amp; Models.</p>
      )}
      {all.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {HELPERS.map((h) => {
            const options = modelsFor(h.key === 'embeddings' ? 'embeddings' : 'chat', all)
            return (
              <Field key={h.key} label={h.label} hint={h.hint}>
                <Select aria-label={h.label} value={form[h.key] ?? ''} onValueChange={(v) => setForm({ ...form, [h.key]: v || null })}
                  options={[
                    { value: '', label: h.key === 'embeddings' ? 'Not set (search by words only)' : 'Use chat model' },
                    ...options.map((m) => ({ value: m.id, label: `${m.display_name} — ${m.provider_name}` })),
                  ]} />
              </Field>
            )
          })}
        </div>
      )}
      <StepFooter nav={nav} error={save.error} onNext={changed ? () => save.mutateAsync({ ...defaults, ...form }) : undefined} />
    </>
  )
}

// -- 3. you --------------------------------------------------------------------------

function YouStep({ nav, general }: { nav: Nav; general: AllSettings['general'] }) {
  const save = useSaveGeneral()
  const [form, setForm] = useState(general)
  const device = deviceTimeZone()
  const dirty = JSON.stringify(form) !== JSON.stringify(general)
  return (
    <>
      <Intro>Your time zone decides when a day starts, when reminders and automations run, and what “today” is for tasks.</Intro>
      <Field label="Time zone" hint="IANA name, e.g. Europe/Amsterdam.">
        <Input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
      </Field>
      {device && device !== form.timezone && (
        <div>
          <Button size="sm" variant="secondary" onClick={() => setForm({ ...form, timezone: device })}>
            Use this device’s time zone ({device})
          </Button>
        </div>
      )}
      <Field label="Start page" hint="What opening Anemo shows. The New chat button always starts a chat.">
        <Select aria-label="Start page" value={form.start_page}
          onValueChange={(v) => setForm({ ...form, start_page: v as typeof form.start_page })}
          options={[{ value: 'home', label: 'Home' }, { value: 'new_chat', label: 'New chat' }]} />
      </Field>
      <StepFooter nav={nav} error={save.error} onNext={dirty ? () => save.mutateAsync(form) : undefined} />
    </>
  )
}

// -- 4. optional parts ---------------------------------------------------------------

function PartsStep({ nav }: { nav: Nav }) {
  const status = useSystemStatus()
  const parts = (status.data?.checks ?? []).filter((c) => c.group === 'part')
  return (
    <>
      <Intro>
        Anemo works without these; each adds something agents can do. One that is off says the command that starts it,
        to run in Anemo’s folder on the server. Then check again.
      </Intro>
      <Card>
        <CardBody className="py-2">
          {status.isError && <p className="py-2 text-[13px] text-error">{errorMessage(status.error)}</p>}
          <ul aria-label="Optional parts">{parts.map((check) => <CheckRow key={check.name} check={check} />)}</ul>
        </CardBody>
      </Card>
      <div>
        <Button size="sm" variant="secondary" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={status.isFetching} onClick={() => void status.refetch()}>
          Check again
        </Button>
      </div>
      <StepFooter nav={nav} />
    </>
  )
}

// -- 5. notifications ----------------------------------------------------------------

function NotificationsStep({ nav, finishing }: { nav: Nav; finishing: boolean }) {
  const destinations = useDestinations()
  const [editing, setEditing] = useState<Destination | null>(null)
  const devices = (destinations.data ?? []).filter((d) => d.type === 'webpush')
  return (
    <>
      <Intro>
        Reminders, automation results and agents waiting for you appear under Notifications. To get them while Anemo
        is closed, turn on push for this device, or add a Discord channel in{' '}
        <Link to="/settings/notifications" className="text-accent underline">Settings → Notifications</Link>.
      </Intro>
      <PushCard devices={devices} onEdit={setEditing} />
      <StepFooter nav={nav} busy={finishing} />
      <Lingering value={editing}>{(shown) => <DestinationDialog destination={shown} onClose={() => setEditing(null)} />}</Lingering>
    </>
  )
}

// -- the page ------------------------------------------------------------------------

export function SetupPage() {
  const settings = useSettings()
  if (settings.isError && !settings.data) {
    return (
      <EmptyState icon={<Rocket className="h-6 w-6" />} title="Couldn’t load the setup"
        description={errorMessage(settings.error)}
        action={<Button onClick={() => void settings.refetch()} disabled={settings.isFetching}>Try again</Button>} />
    )
  }
  if (!settings.data) return null
  return <Setup settings={settings.data} />
}

function Setup({ settings }: { settings: AllSettings }) {
  const navigate = useNavigate()
  const save = useSaveSection('setup')
  const [step, setStep] = useState<StepId>(() => startStep(settings.setup.step))
  // Going through it again after finishing keeps it finished.
  const status = settings.setup.status === 'done' ? 'done' : 'new'

  const go = (next: StepId) => {
    setStep(next)
    save.mutate({ status, step: next })
    window.scrollTo({ top: 0 })
  }
  const leave = () => {
    save.mutate({ status: status === 'done' ? 'done' : 'later', step })
    navigate('/home')
  }
  const finish = async () => {
    try {
      await save.mutateAsync({ status: 'done', step: null })
      navigate('/home')
    } catch (err) {
      toast({ message: `Couldn’t finish the setup: ${errorMessage(err)}` })
    }
  }
  const back = neighbour(step, -1)
  const forward = neighbour(step, 1)
  const nav: Nav = {
    step,
    back: back ? () => go(back) : null,
    next: () => (forward ? go(forward) : void finish()),
    last: forward === null,
  }
  const index = STEPS.findIndex((s) => s.id === step)

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6 md:py-10">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Rocket className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">Set up Anemo</h1>
          <p className="text-[13px] text-muted">A few steps, each one optional. Everything here can be changed later in Settings.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={leave}>Not now</Button>
      </div>

      <nav aria-label="Setup steps">
        <ol className="flex gap-1 overflow-x-auto">
          {STEPS.map((s, i) => (
            <li key={s.id} className="min-w-0 flex-1">
              <button type="button" onClick={() => go(s.id)} aria-current={s.id === step ? 'step' : undefined}
                className={cn('flex w-full flex-col items-start gap-1 rounded-control px-2 py-1.5 text-left hover:bg-surface-hover')}>
                <span className={cn('h-1 w-full rounded-full', i <= index ? 'bg-accent' : 'bg-surface-2')} />
                <span className={cn('truncate text-[12px]', s.id === step ? 'font-semibold text-text' : 'text-muted')}>
                  <span className="sr-only">Step {i + 1}: </span>{s.title}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <section aria-labelledby="setup-step" className="flex flex-col gap-4">
        <h2 id="setup-step" className="flex items-center gap-2 text-[16px] font-semibold [&>svg]:h-4 [&>svg]:w-4 [&>svg]:text-accent">
          {ICONS[step]}
          {STEPS[index].title}
          {STEPS[index].optional && <span className="text-[12px] font-normal text-subtle">optional</span>}
        </h2>
        {step === 'provider' && <ProviderStep key={step} nav={nav} defaults={settings.models} />}
        {step === 'models' && <ModelsStep key={step} nav={nav} defaults={settings.models} />}
        {step === 'you' && <YouStep key={step} nav={nav} general={settings.general} />}
        {step === 'parts' && <PartsStep key={step} nav={nav} />}
        {step === 'notifications' && <NotificationsStep key={step} nav={nav} finishing={save.isPending} />}
      </section>
    </div>
  )
}
