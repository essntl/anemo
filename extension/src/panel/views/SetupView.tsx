import { useState } from 'react'
import { KeyRound, Link2, PlugZap } from 'lucide-react'
import type { ApiError } from '@/shared/api'
import { originPattern, parseServerUrl, type Connection } from '@/shared/connection'
import { testConnection, type Step } from '@/shared/connect'
import { storage } from '@/shared/storage'
import { Button } from '../ui/Button'
import { Field, Input } from '../ui/Input'
import { Notice } from '../ui/Notice'
import { helpFor } from '../lib/help'
import { saveConnection } from '../state/connection'
import { applyAccent } from '../theme'

const STEP_LABEL: Record<Step, string> = { server: 'Reaching Anemo', token: 'Checking the token', origin: 'Checking access' }

export function SetupView({ connection }: { connection: Connection | null }) {
  const [address, setAddress] = useState(connection?.serverUrl ?? '')
  const [token, setToken] = useState('')
  const [addressError, setAddressError] = useState<string | null>(null)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ step: Step | 'permission'; error: ApiError | null } | null>(null)
  const [busy, setBusy] = useState<Step | 'permission' | null>(null)
  const parsed = address.trim() ? parseServerUrl(address) : null

  const connect = async () => {
    setFailure(null)
    const url = parseServerUrl(address)
    setAddressError(url.ok ? null : url.error)
    const tokenText = token.trim()
    setTokenError(!tokenText ? 'Paste the token you created in Anemo.' : null)
    if (!url.ok || !tokenText) return
    // First thing in the click: Chrome only shows the permission prompt for a user action.
    setBusy('permission')
    let granted = false
    try {
      granted = await chrome.permissions.request({ origins: [originPattern(url.url)] })
    } catch {
      granted = false
    }
    if (!granted) {
      setBusy(null)
      setFailure({ step: 'permission', error: null })
      return
    }
    setBusy('server')
    const result = await testConnection(url.url, tokenText)
    setBusy(null)
    if (!result.ok) {
      setFailure({ step: result.step, error: result.error })
      return
    }
    applyAccent(result.accent)
    await storage.set('local', 'accent', result.accent)
    await saveConnection(url.url, tokenText, result.username)
    void chrome.runtime.sendMessage({ type: 'connection.changed' }).catch(() => undefined)
  }

  const help = failure ? helpFor(failure.step, failure.error, chrome.runtime.id) : null

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 py-6">
      <div className="flex items-center gap-3">
        <img src="/icons/icon-48.png" alt="" className="h-10 w-10 rounded-xl" />
        <div>
          <h1 className="text-[17px] font-semibold">Connect to Anemo</h1>
          <p className="text-[12.5px] text-muted">Your own Anemo server, in the browser.</p>
        </div>
      </div>

      {connection?.lostReason === 'revoked' && (
        <Notice tone="warning" title="The token stopped working">
          It was revoked in Anemo (or is no longer valid). Create a new one to connect again.
        </Notice>
      )}

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void connect()
        }}
      >
        <Field label="Anemo address" hint={parsed?.ok && parsed.insecure ? 'Plain http: only use this on your own network.' : 'The address you open Anemo at, e.g. https://ai.example.com'} error={addressError}>
          {(id) => (
            <Input id={id} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://ai.example.com" autoComplete="url" spellCheck={false} inputMode="url" />
          )}
        </Field>
        <Field
          label="API token"
          error={tokenError}
          hint={token.trim() && !token.trim().startsWith('anemo_') ? 'Anemo tokens start with anemo_. Is this the whole token?' : 'In Anemo: Settings → General → Extension and device tokens → Create token.'}
        >
          {(id) => (
            <Input id={id} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="anemo_…" autoComplete="off" spellCheck={false} />
          )}
        </Field>
        <Button type="submit" variant="primary" icon={<PlugZap className="h-4 w-4" />} loading={busy !== null}>
          {busy && busy !== 'permission' ? `${STEP_LABEL[busy]}…` : 'Connect'}
        </Button>
      </form>

      {help && <Notice tone="error" title={help.title}>{help.body}</Notice>}

      <div className="flex flex-col gap-2 text-[12.5px] text-muted">
        <div className="flex gap-2"><Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Chrome asks once to allow this address: the extension can’t reach any other site on its own.</div>
        <div className="flex gap-2"><KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" /> The token stays on this computer (never synced). Revoke it in Anemo at any time.</div>
      </div>
    </div>
  )
}
