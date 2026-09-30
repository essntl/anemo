import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { type Provider, type ProviderIn, useCreateProvider, useProviderTypes, useUpdateProvider } from '../api'

type ProviderType = ProviderIn['type']

function parseHeaders(text: string): Record<string, string> | string {
  if (!text.trim()) return {}
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>)
      if (entries.every(([, v]) => typeof v === 'string')) return Object.fromEntries(entries) as Record<string, string>
    }
  } catch {
    // fall through
  }
  return 'Headers must be a JSON object of strings, e.g. {"X-Api-Version": "2"}'
}

/** Add a provider, or edit one when `provider` is given. Secrets are write-only. */
export function ProviderDialog({
  open,
  onOpenChange,
  provider,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  provider?: Provider
}) {
  const types = useProviderTypes()
  const create = useCreateProvider()
  const update = useUpdateProvider()
  const editing = Boolean(provider)

  const [type, setType] = useState<ProviderType>(provider?.type ?? 'openai')
  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? '')
  const [apiKey, setApiKey] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const typeInfo = types.data?.find((t) => t.type === type)
  const pending = create.isPending || update.isPending

  const submit = async () => {
    setError(null)
    const headers = parseHeaders(headersText)
    if (typeof headers === 'string') return setError(headers)
    try {
      if (provider) {
        await update.mutateAsync({
          id: provider.id,
          body: {
            name,
            base_url: baseUrl || null,
            ...(apiKey ? { api_key: apiKey } : {}),
            ...(headersText.trim() ? { headers } : {}),
          },
        })
      } else {
        await create.mutateAsync({
          type,
          name: name || typeInfo?.label || type,
          base_url: baseUrl || null,
          api_key: apiKey || null,
          headers,
          enabled: true,
        })
      }
      onOpenChange(false)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${provider?.name}` : 'Add provider'}
      description="API keys are encrypted on the server and never shown again."
      className="w-[min(92vw,520px)]"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={pending} onClick={submit}>
            {editing ? 'Save' : 'Add provider'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!editing && (
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value as ProviderType)}>
              {types.data?.map((t) => (
                <option key={t.type} value={t.type}>{t.label}</option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Name">
          <Input value={name} placeholder={typeInfo?.label} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="Base URL"
          hint={typeInfo?.default_base_url ? `Leave empty to use ${typeInfo.default_base_url}` : undefined}
        >
          <Input
            value={baseUrl}
            placeholder={typeInfo?.default_base_url ?? ''}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Field>
        <Field
          label="API key"
          hint={
            editing
              ? provider?.api_key_masked
                ? `Stored key ${provider.api_key_masked}. Leave empty to keep it.`
                : 'No key stored.'
              : typeInfo && !typeInfo.needs_key
                ? 'Optional for most local servers.'
                : undefined
          }
        >
          <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </Field>
        <details className="text-[13px]">
          <summary className="cursor-pointer text-muted">Advanced: extra HTTP headers</summary>
          <div className="mt-2">
            <Field
              label="Headers (JSON)"
              hint={
                editing && provider?.header_names.length
                  ? `Currently set: ${provider.header_names.join(', ')}. Entering a value replaces them.`
                  : 'Stored encrypted.'
              }
            >
              <textarea
                className="min-h-20 w-full rounded-control border border-border bg-surface p-3 font-mono text-[12px] focus:border-accent focus:outline-none"
                value={headersText}
                placeholder='{"X-Custom-Header": "value"}'
                onChange={(e) => setHeadersText(e.target.value)}
              />
            </Field>
          </div>
        </details>
        {error && <p className="rounded-control bg-error/10 px-3 py-2 text-[13px] text-error">{error}</p>}
      </div>
    </Dialog>
  )
}
