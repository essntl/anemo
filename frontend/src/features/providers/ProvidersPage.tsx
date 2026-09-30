import { useState } from 'react'
import { Plug, Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { useSettings } from '@/features/settings/api'
import { useModels, useProviders, useSetupStatus } from './api'
import { ModelDefaultsCard } from './components/ModelDefaultsCard'
import { ProviderCard } from './components/ProviderCard'
import { ProviderDialog } from './components/ProviderDialog'

export function ProvidersPage() {
  const providers = useProviders()
  const models = useModels()
  const settings = useSettings()
  const setup = useSetupStatus()
  const [adding, setAdding] = useState(false)

  const allModels = models.data ?? []

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Providers & Models</h2>
          <p className="text-[13px] text-muted">Connect AI providers, pick models, and choose defaults per task.</p>
        </div>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
          Add provider
        </Button>
      </div>

      {setup.data && !setup.data.has_chat_default && (
        <div className="rounded-card border border-accent/30 bg-accent-soft px-5 py-4 text-[13px]">
          <strong className="text-accent">Getting started:</strong>{' '}
          {!setup.data.has_provider
            ? 'add a provider (OpenAI, Anthropic, OpenRouter or a local server).'
            : !setup.data.has_model
              ? 'use “Add models” on your provider to pick the models you want.'
              : 'choose a default chat model below.'}
        </div>
      )}

      {providers.data?.length === 0 && (
        <Card>
          <EmptyState
            icon={<Plug className="h-5 w-5" />}
            title="No providers yet"
            description="Add an AI provider to start chatting. Keys are encrypted and stay on your server."
            action={<Button variant="primary" onClick={() => setAdding(true)}>Add provider</Button>}
          />
        </Card>
      )}

      {providers.data?.map((p) => (
        <ProviderCard key={p.id} provider={p} models={allModels.filter((m) => m.provider_id === p.id)} />
      ))}

      {settings.data && allModels.length > 0 && (
        <ModelDefaultsCard
          key={JSON.stringify(settings.data.models)}
          initial={settings.data.models}
          models={allModels}
        />
      )}

      {adding && <ProviderDialog open onOpenChange={setAdding} />}
    </div>
  )
}
