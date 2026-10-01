/** Settings > Memory: whether memory is used, how new memories are saved, and search. */
import { useState } from 'react'
import { Link } from 'react-router'
import { Brain } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { useSettings } from '@/features/settings/api'
import { type MemorySettings, useMemorySummary, useReindexMemories, useSaveMemorySettings } from './api'

const EXTRACTION_OPTIONS = [
  { value: 'suggest', label: 'Suggest them, I approve' },
  { value: 'auto', label: 'Save them automatically' },
  { value: 'off', label: 'Off: only when I ask' },
]

function MemoryForm({ initial }: { initial: MemorySettings }) {
  const save = useSaveMemorySettings()
  const summary = useMemorySummary()
  const reindex = useReindexMemories()
  const [form, setForm] = useState<MemorySettings>(initial)
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  const total = (summary.data?.active ?? 0) + (summary.data?.pending ?? 0)

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="Using memory" />
        <CardBody className="flex flex-col gap-5">
          <div className="flex items-center justify-between gap-4 text-[13px]">
            <div>
              <div className="font-medium">Remember things about me</div>
              <div className="text-[12px] text-muted">
                Memories that fit a message are given to the model, and the assistant can save new ones when you ask.
                Off: nothing is used or saved; existing memories are kept.
              </div>
            </div>
            <Switch label="Remember things about me" checked={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Things noticed in conversations"
              hint="A few minutes after a chat goes quiet, the Memory model reads it for lasting facts and preferences. This costs a small model call per conversation.">
              <Select value={form.extraction} disabled={!form.enabled}
                onValueChange={(v) => setForm({ ...form, extraction: v as MemorySettings['extraction'] })}
                options={EXTRACTION_OPTIONS} />
            </Field>
            <Field label="Relevant memories per message" hint="Besides the ones marked “Always in context”.">
              <Input type="number" min={0} max={30} value={form.max_injected} disabled={!form.enabled}
                onChange={(e) => setForm({ ...form, max_injected: Number(e.target.value) || 0 })} />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Finding the right memories"
          description="Memories are always found by their words. With an embedding model they are also found by meaning (“my pet” finds “has a dog called Bruno”)." />
        <CardBody className="flex flex-col gap-3 text-[13px]">
          {summary.data?.embedding_model ? (
            <>
              <p>
                Embedding model: <span className="font-medium">{summary.data.embedding_model}</span>.{' '}
                {summary.data.indexed} of {total} memories are indexed with it.
              </p>
              <div className="flex items-center gap-3">
                <Button size="sm" variant="secondary" loading={reindex.isPending} onClick={() => reindex.mutate()}>
                  Index all memories again
                </Button>
                {reindex.isSuccess && <span className="text-[12.5px] text-success">Started. This takes a moment.</span>}
                {reindex.isError && <span className="text-[12.5px] text-error">{errorMessage(reindex.error)}</span>}
              </div>
              <p className="text-[12px] text-muted">Do this after choosing a different embedding model.</p>
            </>
          ) : (
            <p className="text-muted">
              No embedding model is set, so memories are found by words only. Choose one under{' '}
              <Link to="/settings/providers" className="text-accent underline">Providers & Models</Link> → Embeddings
              (for example OpenAI’s text-embedding-3-small, or a local one in Ollama).
            </p>
          )}
        </CardBody>
      </Card>

      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(form)}>Save</Button>
        {dirty && <Button variant="ghost" onClick={() => setForm(initial)}>Discard</Button>}
        {save.isError && <span className="text-[13px] text-error">{errorMessage(save.error)}</span>}
        {save.isSuccess && !dirty && <span className="text-[13px] text-success">Saved.</span>}
      </div>
    </div>
  )
}

export function MemorySettingsPage() {
  const settings = useSettings()
  const memory = settings.data?.memory as MemorySettings | undefined
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Brain className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Memory</h2>
          <p className="text-[13px] text-muted">
            What is remembered is on the <Link to="/memory" className="text-accent underline">Memory page</Link>, where you
            can edit and delete it.
          </p>
        </div>
      </div>
      {memory && <MemoryForm key={JSON.stringify(memory)} initial={memory} />}
    </div>
  )
}
