import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Copy, KeyRound } from 'lucide-react'
import { api, unwrap } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'

/**
 * The SSH key agents use from shell commands. It is created by the network
 * sandbox on its first start; the user adds the public half to their server.
 */
export function SshKeyCard() {
  const key = useQuery({
    queryKey: ['shell', 'ssh-key'],
    queryFn: async () => unwrap(await api.GET('/api/shell/ssh-key')),
  })
  const [copied, setCopied] = useState(false)
  const publicKey = key.data?.public_key

  const copy = async () => {
    if (!publicKey) return
    await navigator.clipboard.writeText(publicKey)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Card>
      <CardHeader
        title="SSH from agent commands"
        description="Agents can run commands on your own servers with ssh, scp and rsync, using a key made just for them. Your personal keys are never involved."
      />
      <CardBody className="flex flex-col gap-4 text-[13px]">
        {key.data && !key.data.available && (
          <p className="text-muted">
            The key is created when the network sandbox starts for the first time. Start it with{' '}
            <code className="font-mono">docker compose up -d</code> and reload this page.
          </p>
        )}
        {publicKey && (
          <>
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-medium">
                  <KeyRound className="h-4 w-4 text-muted" /> Agents' public key
                </span>
                <Button size="sm" variant="secondary" icon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  onClick={() => void copy()}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <pre className="whitespace-pre-wrap break-all rounded-control bg-surface-2 p-3 font-mono text-[11.5px]">{publicKey}</pre>
              {key.data?.fingerprint && <p className="mt-1 font-mono text-[11.5px] text-subtle">{key.data.fingerprint}</p>}
            </div>
            <ol className="list-decimal space-y-1.5 pl-5 text-muted">
              <li>
                On your server, add the key as one line to <code className="font-mono">~/.ssh/authorized_keys</code> of
                the account agents should use. Best: a dedicated account with only the rights they need.
              </li>
              <li>
                Restrict it to your Docker host, so the key is useless anywhere else: put{' '}
                <code className="font-mono">from="&lt;Docker host IP&gt;" </code> in front of it.
              </li>
              <li>
                Set <strong className="text-text">Shell with network</strong> above to something other than Never
                (SSH needs network access), then ask an agent, e.g. “ssh admin@192.168.1.10 and check the disk usage”.
              </li>
            </ol>
            <p className="rounded-control border border-warning/40 bg-warning/8 px-3 py-2 text-[12.5px]">
              Commands the agent runs can read this key, like any file in the sandbox. That's why steps 1 and 2
              matter. Commands on the server are rated for risk too: <code className="font-mono">ssh host 'rm -rf …'</code>{' '}
              counts as dangerous.
            </p>
          </>
        )}
      </CardBody>
    </Card>
  )
}
