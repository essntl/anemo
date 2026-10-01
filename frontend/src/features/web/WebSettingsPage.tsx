/**
 * Settings > Web & Search: the SearXNG instance for web search, search defaults,
 * and which hosts on your own network agents may reach (everything private is
 * blocked otherwise). Security-sensitive: saving asks for the password.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { CheckCircle2, Globe, Network, XCircle } from 'lucide-react'
import { api, errorMessage, type Schemas, unwrap } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { withReauth } from '@/features/auth/reauthStore'
import { settingsKey, useSettings } from '@/features/settings/api'

type WebSettings = Required<Schemas['WebSettings']>
type TestResult = Schemas['SearchTestOut']

function useWebStatus() {
  return useQuery({ queryKey: ['web', 'status'], queryFn: async () => unwrap(await api.GET('/api/web/status')) })
}

function SearchTest({ url }: { url: string }) {
  const [result, setResult] = useState<TestResult | null>(null)
  const test = useMutation({
    mutationFn: async () => unwrap(await api.POST('/api/web/test-search', { body: { searxng_url: url || null, query: 'open source' } })),
    onSuccess: setResult,
  })
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button size="sm" variant="secondary" loading={test.isPending} onClick={() => test.mutate()}>
          Test search
        </Button>
      </div>
      {test.isError && <p className="text-[12.5px] text-error">{errorMessage(test.error)}</p>}
      {result && (
        <div className={`rounded-control px-3 py-2 text-[12.5px] ${result.ok ? 'bg-success/10' : 'bg-error/10 text-error'}`}>
          <div className="flex items-start gap-1.5">
            {result.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            {result.message}
          </div>
          {result.results.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-6 text-muted">
              {result.results.map((r) => <li key={r.url} className="truncate">{r.title}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function WebForm({ initial }: { initial: WebSettings }) {
  const qc = useQueryClient()
  const status = useWebStatus()
  const [form, setForm] = useState<WebSettings>(initial)
  const [hosts, setHosts] = useState(initial.allowed_private_hosts.join('\n'))
  const body = { ...form, allowed_private_hosts: hosts.split('\n').map((h) => h.trim()).filter(Boolean) }
  const dirty = JSON.stringify(body) !== JSON.stringify(initial)
  const save = useMutation({
    mutationFn: () => withReauth(async () => unwrap(await api.PUT('/api/settings/web', { body }))),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: settingsKey })
      void qc.invalidateQueries({ queryKey: ['web', 'status'] })
    },
  })
  const envUrl = status.data?.env_searxng_url

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="Web search" description="Agents search the web through your SearXNG instance. Without one, the web search tool is not offered." />
        <CardBody className="flex flex-col gap-4">
          <Field label="SearXNG URL"
            hint={envUrl ? `Empty: uses ${envUrl} from the .env file.` : 'e.g. http://searxng:8080 or http://192.168.1.20:8888'}>
            <Input value={form.searxng_url} placeholder={envUrl ?? 'http://searxng:8080'}
              onChange={(e) => setForm({ ...form, searxng_url: e.target.value })} />
          </Field>
          <p className="text-[12px] text-muted">
            SearXNG must allow JSON results: in its <code className="font-mono">settings.yml</code> set{' '}
            <code className="font-mono">search: formats: [html, json]</code>.
          </p>
          <SearchTest url={form.searxng_url} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Results per search">
              <Input type="number" min={1} max={20} value={form.search_results}
                onChange={(e) => setForm({ ...form, search_results: Number(e.target.value) || 1 })} />
            </Field>
            <Field label="Safe search">
              <Select value={form.safesearch} onValueChange={(v) => setForm({ ...form, safesearch: v as WebSettings['safesearch'] })}
                options={[{ value: 'off', label: 'Off' }, { value: 'moderate', label: 'Moderate' }, { value: 'strict', label: 'Strict' }]} />
            </Field>
            <Field label="Language" hint='"auto" or a code like en, de-DE'>
              <Input value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Your network"
          description="Web pages, API calls and the browser used by agents can't reach your home network, this server or its containers. Allow specific hosts here when an agent should talk to them." />
        <CardBody className="flex flex-col gap-3">
          <Field label="Allowed hosts" hint="One per line: a host name (nas.lan), an IP address (192.168.1.20) or a range (192.168.1.0/24).">
            <Textarea rows={4} value={hosts} onChange={(e) => setHosts(e.target.value)} className="font-mono text-[12.5px]"
              placeholder={'homeassistant.lan\n192.168.1.20'} />
          </Field>
          <div className="flex gap-2.5 rounded-control border border-warning/40 bg-warning/8 px-3 py-2.5 text-[12.5px]">
            <Network className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p>
              An allowed host is reachable by any agent run that may read web pages, call APIs or use the browser, including runs
              steered by text on a web page. Allow only what agents need, and prefer services with their own login.
              Shell commands with network access are separate: they can reach your network anyway.
            </p>
          </div>
        </CardBody>
      </Card>

      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        {dirty && <Button variant="ghost" onClick={() => { setForm(initial); setHosts(initial.allowed_private_hosts.join('\n')) }}>Discard</Button>}
        {save.isError && <span className="text-[13px] text-error">{errorMessage(save.error)}</span>}
        {save.isSuccess && !dirty && <span className="text-[13px] text-success">Saved. New agent runs use these settings.</span>}
      </div>
    </div>
  )
}

export function WebSettingsPage() {
  const settings = useSettings()
  const web = settings.data?.web as WebSettings | undefined
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Globe className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Web & Search</h2>
          <p className="text-[13px] text-muted">
            How agents search and read the web. Whether they may at all is set in{' '}
            <Link to="/settings/permissions" className="text-accent underline">Agent Permissions</Link>.
          </p>
        </div>
      </div>
      {web && <WebForm key={JSON.stringify(web)} initial={web} />}
    </div>
  )
}
