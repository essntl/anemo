import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { msg, t } from '@/lib/i18n'
import type { DeviceOptions } from '../deviceOptions'

const KIND_LABELS: Record<string, string> = {
  read: msg('reads'),
  write: msg('writes'),
  delete: msg('deletes'),
  run: msg('runs a program in'),
}

/** The analysis: the rule that decided, what the command does where, and what it couldn't read. */
export function DeviceApproval({ options }: { options: DeviceOptions }) {
  const effects = options.effects.filter((e) => e.kind !== 'read')
  return (
    <div className="mt-2 flex flex-col gap-1 text-[12.5px]" data-testid="device-approval">
      <div>{t('Anemo Desktop on {device}: {rule}', { device: options.device_name, rule: options.rule })}</div>
      {effects.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {effects.map((e) => (
            <li key={`${e.kind} ${e.path}`} className="flex gap-2">
              <span className="w-28 shrink-0 text-muted">{KIND_LABELS[e.kind] ? t(KIND_LABELS[e.kind]) : e.kind}</span>
              <code className="min-w-0 break-all font-mono">{e.path}</code>
            </li>
          ))}
        </ul>
      )}
      {options.relevance && (
        <div className="text-warning">{t('The relevance check: {why}', { why: options.relevance })}</div>
      )}
      {options.unknown.length > 0 && (
        <div className="text-muted">{t('It can’t tell: {what}', { what: options.unknown.join('; ') })}</div>
      )}
    </div>
  )
}

/** Once, This folder, The next hour (or "this exact command" for one it couldn't read), and Deny. */
function Buttons({ options, busy, onDecide, onDeny }: {
  options: DeviceOptions
  busy: boolean
  onDecide: (scope: 'once' | 'folder' | 'hour' | 'command', folder?: string) => void
  onDeny: () => void
}) {
  const [parent, setParent] = useState(false)
  const folder = parent && options.parent_folder ? options.parent_folder : options.folder ?? undefined
  const has = (scope: DeviceOptions['scopes'][number]) => options.scopes.includes(scope)
  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" loading={busy} onClick={() => onDecide('once')}>{t('Once')}</Button>
        {has('folder') && folder && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide('folder', folder)}
            title={t('Make {folder} a work folder of {device}, until you remove it in Settings', { folder, device: options.device_name })}>
            {t('This folder')}
          </Button>
        )}
        {has('hour') && folder && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide('hour', folder)}
            title={t('Writes, deletes and programs in {folder} on {device}, in every chat, for 60 minutes', { folder, device: options.device_name })}>
            {t('The next hour')}
          </Button>
        )}
        {has('command') && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide('command')}>
            {t('This exact command for the next hour')}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDeny}>{t('Deny')}</Button>
      </div>
      {folder && (has('folder') || has('hour')) && (
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted">
          <span>{t('Folder:')} <code className="font-mono text-text">{folder}</code></span>
          {options.parent_folder && (
            <label className="flex items-center gap-1.5">
              <Checkbox checked={parent} onChange={(e) => setParent(e.target.checked)} />
              {t('use the parent folder')}
            </label>
          )}
        </div>
      )}
    </div>
  )
}

DeviceApproval.Buttons = Buttons
