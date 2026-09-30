import { useState } from 'react'
import { api, errorMessage, unwrap } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field, Input } from '@/components/ui/Input'
import { useReauthStore } from './reauthStore'

/** Mounted once in the app layout. */
export function ReauthDialog() {
  const { pending, resolve } = useReauthStore()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const close = (ok: boolean) => {
    setPassword('')
    setError(null)
    resolve(ok)
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      unwrap(await api.POST('/api/auth/reauth', { body: { password } }))
      close(true)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => !open && close(false)}
      title="Confirm it's you"
      description="This is a security-sensitive setting. Enter your password to continue."
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!password} onClick={submit}>
            Confirm
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Field label="Password" error={error}>
          <Input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  )
}
