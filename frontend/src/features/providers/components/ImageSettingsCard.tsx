import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { t } from '@/lib/i18n'
import { type ImageSettings, useSaveImageSettings } from '../api'

const COUNTS = [1, 2, 3, 4, 6, 8, 10]
const RESOLUTIONS: ImageSettings['max_resolution'][] = ['1K', '2K', '4K']

/**
 * Limits for the generate_image tool: pictures cost money at the provider. Saving asks
 * for the password again (like the permissions). The parent re-mounts this card (via
 * `key`) when the saved settings change.
 */
export function ImageSettingsCard({ initial }: { initial: ImageSettings }) {
  const save = useSaveImageSettings()
  const [form, setForm] = useState<ImageSettings>(initial)
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)

  return (
    <Card>
      <CardHeader
        title={t('Image generation')}
        description={t('Limits for the pictures the assistant makes with the image model chosen above. Each picture costs money at the provider.')}
      />
      <CardBody className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        <div>
          <span className="mb-1 block text-[13px] font-medium">{t('Pictures per request')}</span>
          <Select
            aria-label={t('Pictures per request')}
            value={String(form.max_count)}
            onValueChange={(v) => setForm({ ...form, max_count: Number(v) })}
            options={COUNTS.map((n) => ({ value: String(n), label: String(n) }))}
          />
          <span className="mt-1 block text-[12px] text-muted">{t('The most one request may make; asking for more makes this many.')}</span>
        </div>
        <div>
          <span className="mb-1 block text-[13px] font-medium">{t('Largest resolution')}</span>
          <Select
            aria-label={t('Largest resolution')}
            value={form.max_resolution}
            onValueChange={(v) => setForm({ ...form, max_resolution: v as ImageSettings['max_resolution'] })}
            options={RESOLUTIONS.map((r) => ({ value: r, label: r }))}
          />
          <span className="mt-1 block text-[12px] text-muted">{t('Where the model offers a choice (OpenRouter). Larger pictures cost more.')}</span>
        </div>
        <label className="flex items-center justify-between gap-4 sm:col-span-2">
          <span>
            <span className="block text-[13px] font-medium">{t('Automations ask first')}</span>
            <span className="block text-[12px] text-muted">{t('A scheduled run waits for your approval before each picture, whatever the “Generate images” permission says.')}</span>
          </span>
          <Switch label={t('Automations ask first')} checked={form.ask_in_automations}
            onChange={(v) => setForm({ ...form, ask_in_automations: v })} />
        </label>
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(form)}>
            {t('Save')}
          </Button>
          {save.isError && <span className="text-[13px] text-error">{errorMessage(save.error)}</span>}
          {save.isSuccess && !dirty && <span className="text-[13px] text-success">{t('Saved')}</span>}
        </div>
      </CardBody>
    </Card>
  )
}
