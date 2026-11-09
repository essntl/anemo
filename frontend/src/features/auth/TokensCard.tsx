import { useState } from 'react'
import { Check, Copy, KeyRound, Puzzle } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { confirmDialog } from '@/components/ui/dialogs'
import { Field, Input } from '@/components/ui/Input'
import { formatWhen } from '@/lib/format'
import { useCreateToken, useRevokeToken, useTokens } from './api'

/** The token just created: shown once, here, until the card is left. */
function NewToken({ token, onDone }: { token: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(token)
    setCopied(true)
  }
  return (
    <div className="flex flex-col gap-2 rounded-control border border-border bg-surface-2 p-3" role="status">
      <div className="text-[13px] font-medium">Copy the token now: it is shown only this once.</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md bg-surface px-2 py-1.5 font-mono text-[12px]" data-testid="new-token">
          {token}
        </code>
        <Button size="sm" icon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="text-[12px] text-muted">
        Paste it into Anemo Companion (or the device it is for). Anyone with this token can use your workspace,
        except changes that need your password, until you revoke it here.
      </p>
      <div>
        <Button size="sm" variant="ghost" onClick={onDone}>Done</Button>
      </div>
    </div>
  )
}

export function TokensCard() {
  const tokens = useTokens()
  const create = useCreateToken()
  const revoke = useRevokeToken()
  const [name, setName] = useState('')
  const [shown, setShown] = useState<string | null>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    create.mutate(name.trim(), {
      onSuccess: (made) => {
        setShown(made.token)
        setName('')
      },
    })
  }

  const askRevoke = async (id: string, label: string) => {
    const ok = await confirmDialog({
      title: `Revoke “${label}”?`,
      message: 'Whatever uses this token is signed out at once (for the extension: it goes back to its setup screen).',
      confirmLabel: 'Revoke',
      danger: true,
    })
    if (ok) revoke.mutate(id)
  }

  return (
    <Card>
      <CardHeader
        title="Extension and device tokens"
        description="Long-lived logins for Anemo Companion (the browser extension) or other devices. Each is shown once when created and can be revoked here."
      />
      <CardBody className="flex flex-col gap-4">
        {shown ? (
          <NewToken token={shown} onDone={() => setShown(null)} />
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field label="Name" hint="Where it will be used, e.g. “Chrome on my laptop”.">
              <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="Chrome on my laptop" />
            </Field>
            <Button type="submit" variant="primary" icon={<KeyRound className="h-3.5 w-3.5" />} disabled={!name.trim()} loading={create.isPending}>
              Create token
            </Button>
          </form>
        )}
        {create.isError && <p className="text-[13px] text-error">{errorMessage(create.error)}</p>}
        {(tokens.data?.length ?? 0) > 0 && (
          <div className="flex flex-col divide-y divide-border">
            {tokens.data?.map((t) => (
              <div key={t.id} className="flex items-center gap-3 py-3">
                <Puzzle className="h-4 w-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">
                    {t.name} <span className="font-mono text-[11px] text-subtle">{t.prefix}…</span>
                  </div>
                  <div className="text-[12px] text-muted">
                    created {formatWhen(t.created_at)} ·{' '}
                    {t.last_used_at ? `last used ${formatWhen(t.last_used_at)}${t.last_used_ip ? ` from ${t.last_used_ip}` : ''}` : 'never used'}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void askRevoke(t.id, t.name)}>
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
