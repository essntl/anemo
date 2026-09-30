import { useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { Bot } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { useLogin, useMe } from './api'

export function LoginPage() {
  const me = useMe()
  const login = useLogin()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  // Only allow same-app relative redirects after login.
  const next = params.get('next')
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/'

  if (me.data) return <Navigate to={target} replace />

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form
        className="w-full max-w-sm rounded-panel border border-border bg-card p-8 shadow-float"
        onSubmit={(e) => {
          e.preventDefault()
          login.mutate({ username, password }, { onSuccess: () => navigate(target, { replace: true }) })
        }}
      >
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent text-accent-contrast">
            <Bot className="h-6 w-6" />
          </div>
          <h1 className="text-lg font-semibold">anemo</h1>
          <p className="text-[13px] text-muted">Sign in to continue</p>
        </div>

        <div className="flex flex-col gap-4">
          <Field label="Username">
            <Input
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {login.isError && (
            <p role="alert" className="rounded-control bg-error/10 px-3 py-2 text-[13px] text-error">
              {errorMessage(login.error)}
            </p>
          )}
          <Button
            type="submit"
            variant="primary"
            className="mt-1 justify-center"
            loading={login.isPending}
            disabled={!username || !password}
          >
            Sign in
          </Button>
        </div>
      </form>
    </div>
  )
}
