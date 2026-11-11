/**
 * Add or edit an MCP server: a remote one (a URL) or a local one (a program that
 * is run in the separate mcp-host container). Headers and environment variables
 * usually hold API keys; they are stored encrypted and never shown again.
 */
import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { msg, rich, t } from '@/lib/i18n'
import { type McpServer, type Transport, useSaveMcpServer } from '../api'
import { badLines, parseArgs, parsePairs, splitCommand } from '../lines'

const TRANSPORTS: { value: Transport; label: string }[] = [
  { value: 'http', label: msg('Remote server (URL)') },
  { value: 'sse', label: msg('Remote server, older SSE type') },
  { value: 'stdio', label: msg('Local program (npx, uvx, …)') },
]

export function ServerDialog({ server, onClose }: { server: McpServer | null; onClose: () => void }) {
  const save = useSaveMcpServer()
  const [name, setName] = useState(server?.name ?? '')
  const [transport, setTransport] = useState<Transport>(server?.transport ?? 'http')
  const [url, setUrl] = useState(server?.url ?? '')
  const [command, setCommand] = useState(server?.command ?? '')
  const [args, setArgs] = useState((server?.args ?? []).join('\n'))
  // Headers (remote) or environment variables (local), one per line.
  const [secrets, setSecrets] = useState('')
  const [clearSecrets, setClearSecrets] = useState(false)

  const local = transport === 'stdio'
  const separator = local ? '=' : ':'
  const savedNames = (local ? server?.env_names : server?.header_names) ?? []
  const wrong = badLines(secrets, separator)
  const valid = name.trim() !== '' && (local ? command.trim() !== '' : /^https?:\/\/\S+/.test(url.trim())) && wrong.length === 0

  /** "npx -y some-server" typed into the command box: move the rest to the arguments. */
  const tidyCommand = () => {
    const parts = splitCommand(command)
    if (parts.args.length === 0) return
    setCommand(parts.command)
    setArgs([...parts.args, ...parseArgs(args)].join('\n'))
  }

  const submit = () => {
    const pairs = parsePairs(secrets, separator)
    // Editing with an empty box keeps what is saved, unless "remove" is ticked.
    const changed = Object.keys(pairs).length > 0 ? pairs : clearSecrets || !server ? {} : null
    save.mutate(
      {
        id: server?.id,
        form: {
          name: name.trim(),
          transport,
          url: url.trim(),
          command: command.trim(),
          args: parseArgs(args),
          headers: local ? null : changed,
          env: local ? changed : null,
        },
      },
      { onSuccess: onClose },
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="md:w-[min(94vw,580px)]"
      title={server ? t('Edit “{name}”', { name: server.name }) : t('Add an MCP server')}
      description={t('MCP servers give agents extra tools, for example for GitHub, a database or your smart home.')}
      footer={
        <>
          {save.isError && <span className="mr-auto self-center text-[12.5px] text-error">{errorMessage(save.error)}</span>}
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={submit}>
            {server ? t('Save') : t('Add server')}
          </Button>
        </>
      }>
      <div className="flex flex-col gap-4">
        {/* "Type" is also a verb elsewhere (typing in the browser): the empty {kind} keeps this translation apart. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Name')} hint={server ? undefined : t('Shown to you and to the agent')}>
            <Input value={name} maxLength={60} placeholder={t('e.g. GitHub')} autoFocus={!server} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('Type')} hint={server ? t('Cannot be changed later; add a new server instead') : undefined}>
            <Select value={transport} options={TRANSPORTS.map((o) => ({ ...o, label: t(o.label) }))} disabled={server !== null} onValueChange={(v) => setTransport(v as Transport)} />
          </Field>
        </div>

        {!local && (
          <Field label={t('URL')} hint={t('Usually ends in {path}', { path: transport === 'sse' ? '/sse' : '/mcp' })}>
            <Input value={url} maxLength={1000} spellCheck={false} placeholder="https://example.com/mcp" onChange={(e) => setUrl(e.target.value)} />
          </Field>
        )}
        {local && (
          <>
            <Field label={t('Command')} hint={t('The program to start, e.g. npx or uvx')}>
              <Input value={command} maxLength={500} spellCheck={false} className="font-mono" placeholder="npx"
                onChange={(e) => setCommand(e.target.value)} onBlur={tidyCommand} />
            </Field>
            <Field label={t('Arguments')} hint={t('One per line')}>
              <Textarea rows={3} value={args} spellCheck={false} className="font-mono text-[12.5px]"
                placeholder={'-y\n@modelcontextprotocol/server-everything'} onChange={(e) => setArgs(e.target.value)} />
            </Field>
            <p className="-mt-2 text-[12px] text-muted">
              {rich('Local programs run in the separate MCP host container, which is off by default. Start it once with <code>docker compose --profile mcp up -d</code>.', { code: (c) => <code className="font-mono">{c}</code> })}
            </p>
          </>
        )}

        <Field label={local ? t('Environment variables (optional)') : t('Headers (optional)')}
          error={wrong.length > 0 ? t('Not “name{separator} value”: {line}', { separator, line: wrong[0] }) : undefined}
          hint={savedNames.length > 0
            ? t('Saved: {names}. Leave empty to keep them; anything you enter replaces them all.', { names: savedNames.join(', ') })
            : t('One per line. Stored encrypted and never shown again.')}>
          <Textarea rows={2} value={secrets} spellCheck={false} autoComplete="off" className="font-mono text-[12.5px]"
            placeholder={local ? 'API_KEY=…' : 'Authorization: Bearer …'} onChange={(e) => setSecrets(e.target.value)} />
        </Field>
        {savedNames.length > 0 && secrets.trim() === '' && (
          <label className="-mt-2 flex items-center gap-2 text-[13px]">
            <input type="checkbox" className="accent-[var(--accent)]" checked={clearSecrets} onChange={(e) => setClearSecrets(e.target.checked)} />
            {local ? t('Remove the saved variables') : t('Remove the saved headers')}
          </label>
        )}

        <div className="flex gap-2.5 rounded-control border border-warning/40 bg-warning/8 px-3 py-2.5 text-[12.5px]">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p>
            {t('Only add servers you trust. A server sees everything an agent sends to its tools, and what its tools answer can try to steer the agent.')}{' '}
            {local && `${t('A local program can also use the internet and whatever you put in its variables.')} `}
            {t('Its tools ask you before they run unless you allow them.')}
          </p>
        </div>
      </div>
    </Dialog>
  )
}
