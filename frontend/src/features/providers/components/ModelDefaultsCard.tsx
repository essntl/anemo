import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import { type Model, type ModelDefaults, useSaveModelDefaults } from '../api'
import { msg, t } from '@/lib/i18n'

type TaskKey = Exclude<keyof ModelDefaults, 'fallbacks'>

const TASKS: { key: TaskKey; label: string; hint: string; needs?: string }[] = [
  { key: 'chat', label: msg('Chat'), hint: msg('Normal conversations. Other tasks fall back to this.') },
  { key: 'agent', label: msg('Agent'), hint: msg('Autonomous work with tools.'), needs: 'tools' },
  { key: 'title', label: msg('Titles'), hint: msg('Naming conversations. A small, fast model is ideal.') },
  { key: 'summarization', label: msg('Summaries'), hint: msg('Compacting long conversations and documents.') },
  { key: 'memory', label: msg('Memory'), hint: msg('Extracting memories from conversations.') },
  { key: 'background', label: msg('Background tasks'), hint: msg('Indexing and other housekeeping.') },
  { key: 'inline', label: msg('Inline & formatting'), hint: msg('Anemo Companion: translate and explain on web pages, and formatting what it saves. A fast model is ideal.') },
  { key: 'automation', label: msg('Automations'), hint: msg('Scheduled agent jobs.'), needs: 'tools' },
  { key: 'embeddings', label: msg('Embeddings'), hint: msg('Semantic search and memory retrieval.'), needs: 'embeddings' },
]

// Parent re-mounts this card (via `key`) when the saved defaults change.
export function ModelDefaultsCard({ initial, models }: { initial: ModelDefaults; models: Model[] }) {
  const save = useSaveModelDefaults()
  const [form, setForm] = useState<ModelDefaults>(initial)
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  const enabled = models.filter((m) => m.enabled)

  return (
    <Card>
      <CardHeader
        title={t('Default models')}
        description={t('Choose which model handles each kind of work. Leave a task on “Use chat model” to share it.')}
      />
      <CardBody className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {TASKS.map((task) => {
          const options = enabled.filter((m) =>
            task.key === 'embeddings'
              ? m.capabilities.embeddings
              : m.capabilities.chat !== false && (!task.needs || m.capabilities[task.needs]),
          )
          return (
            <div key={task.key}>
              <span className="mb-1 block text-[13px] font-medium">{t(task.label)}</span>
              <Select
                aria-label={t(task.label)}
                value={form[task.key] ?? ''}
                onValueChange={(v) => setForm({ ...form, [task.key]: v || null })}
                options={[
                  {
                    value: '',
                    label: task.key === 'chat' ? t('Not set') : task.key === 'embeddings' ? t('Not set (disables semantic search)') : t('Use chat model'),
                  },
                  ...options.map((m) => ({ value: m.id, label: `${m.display_name} — ${m.provider_name}` })),
                ]}
              />
              <span className="mt-1 block text-[12px] text-muted">{t(task.hint)}</span>
            </div>
          )
        })}
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(form)}>
            {t('Save defaults')}
          </Button>
          {save.isError && <span className="text-[13px] text-error">{errorMessage(save.error)}</span>}
          {save.isSuccess && !dirty && <span className="text-[13px] text-success">{t('Saved')}</span>}
        </div>
      </CardBody>
    </Card>
  )
}
