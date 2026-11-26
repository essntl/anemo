import { Card } from '@/components/ui/Card'
import { SettingRow } from '@/components/ui/SettingRow'
import { useSaveSection, useSettings } from '@/features/settings/api'
import { t } from '@/lib/i18n'

/** The default of Auto continue for Claude Code jobs that stop at the usage limit (code-sessions.md §16). */
export function DeviceCodeCard() {
  const settings = useSettings()
  const save = useSaveSection('code')
  const code = settings.data?.code
  if (!code) return null
  return (
    <Card>
      <SettingRow heading title={t('Auto continue Claude Code jobs')}
        description={t('A job that stops at your Claude subscription’s usage limit resumes its session by itself a few minutes after the limit resets, at most three times in a row. Each job’s “Limit reached” panel can turn it on or off.')}
        checked={code.auto_continue} disabled={save.isPending}
        onCheckedChange={(auto_continue) => save.mutate({ ...code, auto_continue })} />
    </Card>
  )
}
