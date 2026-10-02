import { useState } from 'react'
import { CheckCircle2, Pencil, Plug, Search, Trash2, XCircle, Zap } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Switch } from '@/components/ui/Switch'
import {
  type Model,
  type Provider,
  useDeleteModel,
  useDeleteProvider,
  useTestModel,
  useTestProvider,
  useUpdateModel,
  useUpdateProvider,
} from '../api'
import { CapabilityChips } from './CapabilityChips'
import { CapabilityDialog } from './CapabilityDialog'
import { DiscoverDialog } from './DiscoverDialog'
import { ProviderDialog } from './ProviderDialog'
import { confirmDialog } from '@/components/ui/dialogs'
import { Lingering } from '@/components/ui/Lingering'

function TestOutcome({ ok, message }: { ok: boolean; message: string }) {
  return (
    <span className={`flex items-center gap-1.5 text-[12px] ${ok ? 'text-success' : 'text-error'}`}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
      {message}
    </span>
  )
}

function ModelRow({ model }: { model: Model }) {
  const update = useUpdateModel()
  const remove = useDeleteModel()
  const test = useTestModel()
  const [editingCapabilities, setEditingCapabilities] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-4 py-3 md:px-5">
      <Switch
        label={`Enable ${model.display_name}`}
        checked={model.enabled}
        onChange={(enabled) => update.mutate({ id: model.id, body: { enabled } })}
      />
      <div className="min-w-40 flex-1">
        <div className="text-[13px] font-medium">{model.display_name}</div>
        <div className="font-mono text-[11px] text-muted">
          {model.model_key}
          {model.context_window ? ` · ${Math.round(model.context_window / 1000)}k` : ''}
          {model.pricing ? ` · $${model.pricing.input_per_mtok?.toFixed(2)}/$${model.pricing.output_per_mtok?.toFixed(2)} per M` : ''}
        </div>
      </div>
      {/* What the model can do is a starting guess for most providers: press to correct it. */}
      <button type="button" aria-label={`Change what ${model.display_name} can do`} title="Change what this model can do"
        onClick={() => setEditingCapabilities(true)}
        className="-m-1 rounded-control p-1 text-left hover:bg-surface-hover">
        <CapabilityChips capabilities={model.capabilities} />
      </button>
      <Lingering value={editingCapabilities}>{() => <CapabilityDialog model={model} onOpenChange={setEditingCapabilities} />}</Lingering>
      <div className="flex items-center gap-1">
        {test.data && <TestOutcome ok={test.data.ok} message={test.data.ok ? `${test.data.latency_ms} ms` : test.data.message} />}
        {test.isError && <TestOutcome ok={false} message={errorMessage(test.error)} />}
        <Button size="sm" variant="ghost" loading={test.isPending} icon={<Zap className="h-3.5 w-3.5" />} onClick={() => test.mutate(model.id)}>
          Test
        </Button>
        <Button size="icon" variant="ghost" aria-label={`Remove ${model.display_name}`} onClick={() => remove.mutate(model.id)}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

export function ProviderCard({ provider, models }: { provider: Provider; models: Model[] }) {
  const [editing, setEditing] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const test = useTestProvider()
  const update = useUpdateProvider()
  const remove = useDeleteProvider()

  const confirmDelete = async () => {
    const ok = await confirmDialog({
      title: `Delete "${provider.name}"?`,
      message: `Its ${models.length} model(s) are removed and the stored API key is destroyed.`,
      confirmLabel: 'Delete provider',
      danger: true,
    })
    if (ok) remove.mutate(provider.id)
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-4 md:px-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Plug className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[15px] font-semibold">{provider.name}</h3>
            <Badge>{provider.type.replace('_', '-')}</Badge>
            {!provider.enabled && <Badge tone="warning">Disabled</Badge>}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-muted">
            {provider.effective_base_url ?? 'built-in'} · key {provider.api_key_masked ?? 'not set'}
          </div>
          <div className="mt-2 min-h-4">
            {test.data && <TestOutcome ok={test.data.ok} message={test.data.message} />}
            {update.isError && <TestOutcome ok={false} message={errorMessage(update.error)} />}
            {remove.isError && <TestOutcome ok={false} message={errorMessage(remove.error)} />}
          </div>
        </div>
        <div className="flex items-center gap-1 max-md:w-full max-md:justify-end">
          <Switch
            label={`Enable ${provider.name}`}
            checked={provider.enabled}
            onChange={(enabled) => update.mutate({ id: provider.id, body: { enabled } })}
          />
          <Button size="sm" variant="ghost" loading={test.isPending} onClick={() => test.mutate(provider.id)}>
            Test
          </Button>
          <Button size="icon" variant="ghost" aria-label="Edit provider" onClick={() => setEditing(true)}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" aria-label="Delete provider" onClick={() => void confirmDelete()}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {models.map((m) => <ModelRow key={m.id} model={m} />)}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 md:px-5">
        <span className="text-[12px] text-muted">
          {models.length === 0 ? 'No models added yet.' : `${models.length} model${models.length === 1 ? '' : 's'}`}
        </span>
        <Button size="sm" variant="secondary" icon={<Search className="h-3.5 w-3.5" />} onClick={() => setDiscovering(true)}>
          Add models
        </Button>
      </div>

      <Lingering value={editing}>{() => <ProviderDialog open onOpenChange={setEditing} provider={provider} />}</Lingering>
      <Lingering value={discovering}>{() => <DiscoverDialog open onOpenChange={setDiscovering} provider={provider} />}</Lingering>
    </Card>
  )
}
