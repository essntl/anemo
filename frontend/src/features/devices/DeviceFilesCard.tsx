import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { useSaveSection, useSettings } from '@/features/settings/api'
import { t } from '@/lib/i18n'

const MIN_MB = 1
const MAX_MB = 200

/** The largest file the agent copies between a computer and the workspace (device_file_get / device_file_put). */
export function DeviceFilesCard() {
  const settings = useSettings()
  const files = settings.data?.files
  if (!files) return null
  return <DeviceFilesForm key={files.device_file_max_mb} files={files} />
}

function DeviceFilesForm({ files }: { files: NonNullable<ReturnType<typeof useSettings>['data']>['files'] }) {
  const save = useSaveSection('files')
  const [value, setValue] = useState(String(files.device_file_max_mb))
  const mb = Number(value)
  const valid = Number.isInteger(mb) && mb >= MIN_MB && mb <= MAX_MB
  const dirty = valid && mb !== files.device_file_max_mb
  return (
    <Card>
      <CardHeader title={t('Files on your computers')}
        description={t('On a trusted computer with “Let Anemo read and write files” switched on in Anemo Desktop, the agent can copy files between it and the workspace. Anemo Desktop decides which folders: your home folder unless you list others, never hidden or system folders.')} />
      <CardBody className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium">{t('Largest file (MB)')}</span>
          <Input className="w-32" type="number" min={MIN_MB} max={MAX_MB} value={value}
            aria-invalid={!valid} onChange={(e) => setValue(e.target.value)} />
        </label>
        <Button variant="primary" disabled={!dirty} loading={save.isPending}
          onClick={() => save.mutate({ ...files, device_file_max_mb: mb })}>
          {t('Save')}
        </Button>
        {!valid && <span className="text-[13px] text-error">{t('From {min} to {max} MB.', { min: MIN_MB, max: MAX_MB })}</span>}
        {save.isError && <span className="text-[13px] text-error">{errorMessage(save.error)}</span>}
      </CardBody>
    </Card>
  )
}
