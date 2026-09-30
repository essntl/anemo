import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import { type Model, type ModelDefaults, useSaveModelDefaults } from '../api'

type TaskKey = Exclude<keyof ModelDefaults, 'fallbacks'>

const TASKS: { key: TaskKey; label: string; hint: string; needs?: string }[] = [
  { key: 'chat', label: 'Chat', hint: 'Normal conversations. Other tasks fall back to this.' },
  { key: 'agent', label: 'Agent', hint: 'Autonomous work with tools.', needs: 'tools' },
  { key: 'title', label: 'Titles', hint: 'Naming conversations. A small, fast model is ideal.' },
  { key: 'summarization', label: 'Summaries', hint: 'Compacting long conversations and documents.' },
  { key: 'memory', label: 'Memory', hint: 'Extracting memories from conversations.' },
  { key: 'background', label: 'Background tasks', hint: 'Indexing and other housekeeping.' },
  { key: 'automation', label: 'Automations', hint: 'Scheduled agent jobs.', needs: 'tools' },
  { key: 'embeddings', label: 'Embeddings', hint: 'Semantic search and memory retrieval.', needs: 'embeddings' },
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
        title="Default models"
        description="Choose which model handles each kind of work. Leave a task on “Use chat model” to share it."
      />
      <CardBody className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {TASKS.map((task) => {
          const options = enabled.filter((m) =>
            task.key === 'embeddings'
              ? m.capabilities.embeddings
              : m.capabilities.chat !== false && (!task.needs || m.capabilities[task.needs]),
          )
          return (
            <label key={task.key} className="block">
              <span className="mb-1 block text-[13px] font-medium">{task.label}</span>
              <Select
                value={form[task.key] ?? ''}
                onChange={(e) => setForm({ ...form, [task.key]: e.target.value || null })}
              >
                <option value="">
                  {task.key === 'chat' ? 'Not set' : task.key === 'embeddings' ? 'Not set (disables semantic search)' : 'Use chat model'}
                </option>
                {options.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name} — {m.provider_name}
                  </option>
                ))}
              </Select>
              <span className="mt-1 block text-[12px] text-muted">{task.hint}</span>
            </label>
          )
        })}
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(form)}>
            Save defaults
          </Button>
          {save.isError && <span className="text-[13px] text-error">{errorMessage(save.error)}</span>}
          {save.isSuccess && !dirty && <span className="text-[13px] text-success">Saved</span>}
        </div>
      </CardBody>
    </Card>
  )
}
