import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { type Provider, type ProviderIn, useCreateProvider, useProviderTypes, useUpdateProvider } from '../api'
import { ClaudeCodeStatus } from './ClaudeCodeStatus'
import { t } from '@/lib/i18n'

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
  return t('Headers must be a JSON object of strings, e.g. {"X-Api-Version": "2"}')
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
  // A Claude subscription signs in inside the claude-runner container: no URL, no key.
  const subscription = type === 'claude_code'

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
      title={editing ? t('Edit {name}', { name: String(provider?.name) }) : t('Add provider')}
      description={
        subscription
          ? t('Uses your Claude subscription through Claude Code. Every tool call still goes through Agent Permissions.')
          : t('API keys are encrypted on the server and never shown again.')
      }
      className="md:w-[min(92vw,520px)]"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('Cancel')}</Button>
          <Button variant="primary" loading={pending} onClick={submit}>
            {editing ? t('Save') : t('Add provider')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!editing && (
          <Field label={t('Type')}>
            <Select aria-label={t('Type')} value={type} onValueChange={(v) => setType(v as ProviderType)}
              options={(types.data ?? []).map((t) => ({ value: t.type, label: t.label }))} />
          </Field>
        )}
        <Field label={t('Name')}>
          <Input value={name} placeholder={typeInfo?.label} onChange={(e) => setName(e.target.value)} />
        </Field>
        {subscription ? (
          <div className="flex flex-col gap-2 rounded-control border border-border p-3">
            <ClaudeCodeStatus />
            <p className="text-[12px] text-muted">
              {t("No key is needed or stored: Claude Code keeps its own login in the claude-runner container. Chat and agent runs on these models (automations too) count against your subscription's usage limits. See docs/claude-code.md.")}
            </p>
          </div>
        ) : (
          <>
            <Field
              label={t('Base URL')}
              hint={typeInfo?.default_base_url ? t('Leave empty to use {url}', { url: typeInfo.default_base_url }) : undefined}
            >
              <Input
                value={baseUrl}
                placeholder={typeInfo?.default_base_url ?? ''}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </Field>
            <Field
              label={t('API key')}
              hint={
                editing
                  ? provider?.api_key_masked
                    ? t('Stored key {key}. Leave empty to keep it.', { key: provider.api_key_masked })
                    : t('No key stored.')
                  : typeInfo && !typeInfo.needs_key
                    ? t('Optional for most local servers.')
                    : undefined
              }
            >
              <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </Field>
            <details className="text-[13px]">
              <summary className="cursor-pointer text-muted">{t('Advanced: extra HTTP headers')}</summary>
              <div className="mt-2">
                <Field
                  label={t('Headers (JSON)')}
                  hint={
                    editing && provider?.header_names.length
                      ? t('Currently set: {names}. Entering a value replaces them.', { names: provider.header_names.join(', ') })
                      : t('Stored encrypted.')
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
          </>
        )}
        {error && <p className="rounded-control bg-error/10 px-3 py-2 text-[13px] text-error">{error}</p>}
      </div>
    </Dialog>
  )
}
