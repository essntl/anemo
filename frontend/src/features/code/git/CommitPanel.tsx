/**
 * One commit of the Git view, beside the graph: its whole message (plain text, as git has
 * it: never read as HTML or Markdown), who wrote and committed it and when, its parents
 * (a click selects that row) and the files it changed with their added and removed lines.
 */
import type { ReactNode } from 'react'
import { Copy, FileDiff, GitCommitHorizontal, GitMerge, X } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { toast } from '@/components/ui/toast'
import { cn } from '@/lib/cn'
import { formatAgo, formatDateTime } from '@/lib/format'
import { plural, t } from '@/lib/i18n'
import { type GitCommit, type GitCommitDetail, type GitRepoChoice, useGitCommit } from './gitApi'
import { shortHash } from './gitFormat'
import { Avatar } from './GitGraphList'

type GitFile = GitCommitDetail['files'][number]

/** The colour of each status letter. */
const STATUS_COLOR: Record<string, string> = {
  A: 'var(--success)',
  M: 'var(--info)',
  D: 'var(--error)',
  R: 'var(--git-lane-4)',
  C: 'var(--git-lane-6)',
  T: 'var(--warning)',
}

function statusLabel(status: string): string {
  switch (status[0]) {
    case 'A': return t('Added')
    case 'M': return t('Modified')
    case 'D': return t('Deleted')
    case 'R': return t('Renamed')
    case 'C': return t('Copied')
    case 'T': return t('Type changed')
    default: return status
  }
}

/** Green for added lines, red for removed, as long as their share of the biggest change. */
function ChangeBar({ file, most }: { file: GitFile; most: number }) {
  const added = file.additions ?? 0
  const removed = file.deletions ?? 0
  const full = 44
  const scale = most > 0 ? full / most : 0
  const a = added ? Math.max(2, Math.round(added * scale)) : 0
  const r = removed ? Math.max(2, Math.round(removed * scale)) : 0
  return (
    <span aria-hidden="true" className="flex h-1.5 shrink-0 overflow-hidden rounded-full bg-surface-2" style={{ width: full }}>
      <span className="h-full bg-success" style={{ width: a }} />
      <span className="h-full bg-error" style={{ width: r }} />
    </span>
  )
}

function FileRow({ file, most, remote }: { file: GitFile; most: number; remote: boolean }) {
  const slash = file.path.lastIndexOf('/')
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : ''
  const name = file.path.slice(slash + 1)
  const color = STATUS_COLOR[file.status[0]] ?? 'var(--text-muted)'
  const counted = file.additions !== null && file.deletions !== null
  return (
    <li className="flex min-w-0 items-center gap-2 px-4 py-1 text-[12.5px] hover:bg-surface-hover" title={file.path}>
      <span title={statusLabel(file.status)} aria-label={statusLabel(file.status)}
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] font-mono text-[10px] font-semibold"
        style={{ color, backgroundColor: `color-mix(in oklch, ${color} 14%, transparent)` }}>
        {file.status[0]}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
        <span className="text-subtle">{dir}</span><span className="text-text">{name}</span>
      </span>
      {counted ? (
        <>
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            <span className="text-success">+{file.additions}</span> <span className="text-error">−{file.deletions}</span>
          </span>
          <ChangeBar file={file} most={most} />
        </>
      ) : (
        !remote && <span className="shrink-0 rounded-full bg-surface-2 px-1.5 text-[10.5px] text-muted">{t('binary')}</span>
      )}
    </li>
  )
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('border-t border-border py-3', className)}>
      <h3 className="mb-1.5 px-4 text-[11px] font-semibold uppercase tracking-wider text-subtle">{title}</h3>
      {children}
    </section>
  )
}

function Person({ role, name, email, date }: { role: string; name: string; email?: string; date: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 px-4 py-1">
      <Avatar name={name} className="h-7 w-7 text-[11px]" />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-[13px]">
          <span className="font-medium">{name}</span>
          {email && <span className="text-muted"> &lt;{email}&gt;</span>}
        </div>
        <div className="truncate text-[11.5px] text-muted">
          {role} · <time dateTime={date} title={formatDateTime(date)}>{formatAgo(date)}</time> · {formatDateTime(date)}
        </div>
      </div>
    </div>
  )
}

export function CommitPanel({ choice, hash, commit, remote, known, onJump, onClose }: {
  choice: GitRepoChoice
  hash: string
  /** The commit's row in the graph, shown while the details load. */
  commit: GitCommit | undefined
  remote: boolean
  /** Whether a commit is in the graph (its parent link can select it). */
  known: (hash: string) => boolean
  onJump: (hash: string) => void
  onClose: () => void
}) {
  const query = useGitCommit(choice, hash)
  const detail = query.data
  const subject = detail?.subject ?? commit?.subject ?? ''
  const parents = detail?.parents ?? commit?.parents ?? []
  const files = detail?.files ?? []
  const most = Math.max(0, ...files.map((f) => (f.additions ?? 0) + (f.deletions ?? 0)))
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hash)
      toast({ message: t('Copied {hash}', { hash: shortHash(hash) }) })
    } catch {
      toast({ message: t('Couldn’t copy to the clipboard') })
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label={t('Commit {hash}', { hash: shortHash(hash) })} role="region">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        {parents.length > 1
          ? <GitMerge aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
          : <GitCommitHorizontal aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />}
        <span className="text-[12.5px] font-medium text-muted">{parents.length > 1 ? t('Merge commit') : t('Commit')}</span>
        <button type="button" onClick={() => void copy()} title={t('Copy the full hash')}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[12px] text-text hover:bg-surface-hover">
          {shortHash(hash)}<Copy aria-hidden="true" className="h-3 w-3 text-subtle" />
        </button>
        <button type="button" onClick={onClose} aria-label={t('Close')} title={t('Close (Esc)')}
          className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:w-10">
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="px-4 pb-3 pt-3">
          {/* Untrusted text: shown as text, line breaks kept. */}
          <h2 className="whitespace-pre-wrap break-words text-[15px] font-semibold leading-snug [overflow-wrap:anywhere]">{subject || t('(no message)')}</h2>
          {detail?.body && (
            <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-muted [overflow-wrap:anywhere]">{detail.body}</p>
          )}
        </div>

        <Section title={t('Who and when')} className="py-2">
          {detail ? (
            <>
              <Person role={t('authored')} name={detail.authorName} email={detail.authorEmail} date={detail.date} />
              {detail.committerDate !== detail.date && (
                <p className="px-4 pt-1 text-[11.5px] text-muted">
                  {t('Committed {when}', { when: formatDateTime(detail.committerDate) })}
                </p>
              )}
            </>
          ) : commit ? (
            <Person role={t('authored')} name={commit.authorName} email={commit.authorEmail} date={commit.date} />
          ) : null}
        </Section>

        {parents.length > 0 && (
          <Section title={plural(parents.length, 'Parent', 'Parents')}>
            <div className="flex flex-wrap gap-1.5 px-4">
              {parents.map((p) => (
                <button key={p} type="button" onClick={() => onJump(p)} title={known(p) ? t('Show {hash} in the graph', { hash: shortHash(p) }) : t('{hash} is older than the loaded history', { hash: shortHash(p) })}
                  className={cn('rounded-md border border-border px-1.5 py-0.5 font-mono text-[12px] hover:border-border-strong hover:bg-surface-hover',
                    known(p) ? 'text-accent' : 'text-muted')}>
                  {shortHash(p)}
                </button>
              ))}
            </div>
          </Section>
        )}

        <Section title={t('Changes')} className="pb-4">
          {query.isPending ? (
            <div aria-busy="true" aria-label={t('Loading…')} className="space-y-2 px-4 py-1">
              {[0, 1, 2, 3].map((i) => <div key={i} className="h-3.5 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" style={{ width: `${80 - i * 12}%` }} />)}
            </div>
          ) : query.isError ? (
            <div className="px-4 text-[12.5px] text-muted">
              <p>{errorMessage(query.error)}</p>
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => void query.refetch()}>{t('Try again')}</Button>
            </div>
          ) : detail && (
            <>
              <p className="flex items-center gap-2 px-4 pb-1.5 text-[12.5px] text-muted">
                <FileDiff aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span>{plural(detail.stats.files, '{n} file changed', '{n} files changed')}</span>
                {!remote && (
                  <span className="font-mono tabular-nums">
                    <span className="text-success">+{detail.stats.additions}</span> <span className="text-error">−{detail.stats.deletions}</span>
                  </span>
                )}
              </p>
              {remote && (
                <p className="mx-4 mb-2 rounded-control bg-surface-2 px-2.5 py-1.5 text-[12px] text-muted">
                  {t('This repository isn’t cloned on the computer: line counts need a local clone.')}
                </p>
              )}
              <ul aria-label={t('Changed files')}>
                {files.map((f) => <FileRow key={f.path} file={f} most={most} remote={remote} />)}
              </ul>
              {detail.truncated && (
                <p className="px-4 pt-2 text-[12px] text-subtle">{plural(files.length, 'Only the first file is listed.', 'Only the first {n} files are listed.')}</p>
              )}
            </>
          )}
        </Section>
      </div>
    </div>
  )
}
