import { useRef, useState } from 'react'
import { Check, Copy, ExternalLink, RefreshCw } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { formatWhen } from '@/lib/format'
import { type ShareLink, useRefreshShare, useRevokeShare } from './api'
import { expiryLabel, shareUrl } from './links'

const KIND = { chat: 'Chat', document: 'Document', project: 'Project' } as const

/**
 * One share link: its address with a Copy button, when the copy was made, when it
 * expires and how often it was opened, and "Update copy" / "Revoke".
 * `showTarget` adds what the link points to (the list of all links in Settings).
 */
export function LinkRow({ link, showTarget = false }: { link: ShareLink; showTarget?: boolean }) {
  const refresh = useRefreshShare()
  const revoke = useRevokeShare()
  const field = useRef<HTMLInputElement>(null)
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const url = shareUrl(link.token)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      // No clipboard access (e.g. the site is opened over plain http): select it instead.
      field.current?.select()
      document.execCommand('copy')
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  const error = refresh.error ?? revoke.error

  return (
    <div className="flex flex-col gap-2">
      {showTarget && (
        <div className="flex min-w-0 items-center gap-2">
          <Badge>{KIND[link.kind]}</Badge>
          <span className="min-w-0 truncate text-[14px] font-medium">{link.title}</span>
          {link.expired && <Badge tone="warning">Expired</Badge>}
        </div>
      )}
      {!link.expired && (
        <div className="flex gap-2">
          <Input ref={field} readOnly value={url} aria-label="Link" onFocus={(e) => e.target.select()}
            className="min-w-0 flex-1 font-mono text-[12.5px]" />
          <Button variant="secondary" className="shrink-0" onClick={() => void copy()}
            icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted">
        <span>Copy from {formatWhen(link.snapshot_at)}</span>
        <span className={link.expired ? 'text-warning' : undefined}>{expiryLabel(link)}</span>
        <span>{link.view_count === 1 ? 'Opened once' : `Opened ${link.view_count} times`}</span>
        <span className="ml-auto flex items-center gap-1">
          {confirming ? (
            <>
              <span className="mr-1 text-text">Stop this link working?</span>
              <Button size="sm" variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate(link.id)}>Revoke</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
            </>
          ) : (
            <>
              {!link.expired && (
                <>
                  <a href={url} target="_blank" rel="noreferrer" aria-label="Open the link"
                    className="flex h-8 w-8 items-center justify-center rounded-control hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:w-10">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  <Button size="sm" variant="ghost" loading={refresh.isPending} icon={<RefreshCw className="h-3.5 w-3.5" />}
                    title="Make the copy again from how it is now. The link stays the same."
                    onClick={() => refresh.mutate(link.id)}>
                    Update copy
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" className="text-error hover:text-error" onClick={() => (link.expired ? revoke.mutate(link.id) : setConfirming(true))}>
                {link.expired ? 'Remove' : 'Revoke'}
              </Button>
            </>
          )}
        </span>
      </div>
      {error && <p className="text-[12.5px] text-error">{errorMessage(error)}</p>}
    </div>
  )
}
