import { useRef, useState } from 'react'
import { FolderOpen, Paperclip, Plus, Upload, X } from 'lucide-react'
import { Link } from 'react-router'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Lingering } from '@/components/ui/Lingering'
import { cn } from '@/lib/cn'
import { downloadUrl } from '@/features/files/api'
import { useProjects } from '@/features/tasks/api'
import { useAttachFile, useDetachFile, useTaskFiles, useUploadToTask } from './api'
import { FileFinder, FileIcon } from './FileFinder'
import { formatSize, IMAGE } from './files'

const parentOf = (p: string) => p.split('/').slice(0, -1).join('/')

/**
 * The task editor's Attachments: files that stay in Files and are linked here.
 * Upload (into the task's project folder, or files/), pick an existing file, or
 * remove the link (the file stays). Images show a thumbnail; a click opens the file.
 */
export function TaskAttachments({ taskId, projectId }: { taskId: string | null; projectId: string | null }) {
  const files = useTaskFiles(taskId)
  const projects = useProjects()
  const [picking, setPicking] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const upload = useUploadToTask(taskId ?? '')
  const attach = useAttachFile(taskId ?? '')
  const detach = useDetachFile(taskId ?? '')
  const project = projects.data?.find((p) => p.id === projectId)
  const error = upload.error ?? attach.error ?? detach.error

  return (
    <section aria-label="Attachments">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Paperclip className="h-3.5 w-3.5 text-muted" />
        <h3 className="flex-1 text-[13px] font-medium">Attachments</h3>
        {taskId && (
          <>
            <button type="button" aria-label="Upload files" title="Upload files" onClick={() => input.current?.click()}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:w-10">
              <Upload className="h-4 w-4" />
            </button>
            <button type="button" aria-label="Attach a file from Files" title="Attach a file from Files" onClick={() => setPicking(true)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:w-10">
              <Plus className="h-4 w-4" />
            </button>
            <input ref={input} type="file" multiple hidden data-testid="task-upload"
              onChange={(e) => {
                const chosen = Array.from(e.target.files ?? [])
                if (chosen.length) upload.mutate(chosen)
                e.target.value = ''
              }} />
          </>
        )}
      </div>
      {!taskId ? (
        <p className="text-[12.5px] text-muted">Add the task first, then attach files to it.</p>
      ) : (
        <>
          {upload.isPending && <p className="text-[12.5px] text-muted">Uploading…</p>}
          {files.data?.length === 0 && !upload.isPending && (
            <p className="text-[12.5px] text-muted">Upload a file or pick one from Files. It stays in Files; this is a link.</p>
          )}
          <ul className="flex flex-col gap-1">
            {(files.data ?? []).map((f) => (
              <li key={f.path} className={cn('group flex items-center gap-2 rounded-control border border-border p-1.5', !f.exists && 'opacity-60')}>
                <a href={f.exists ? downloadUrl(f.path) : undefined} target={f.exists && IMAGE.test(f.name) ? '_blank' : undefined}
                  rel="noreferrer" title={f.exists ? (IMAGE.test(f.name) ? 'Open' : 'Download') : 'This file is missing (moved to the trash?)'}
                  className="flex min-w-0 flex-1 items-center gap-2">
                  {f.exists && IMAGE.test(f.name) ? (
                    <img src={downloadUrl(f.path)} alt="" className="h-9 w-9 shrink-0 rounded-md object-cover" loading="lazy" />
                  ) : (
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
                      <FileIcon name={f.name} className="h-4 w-4" />
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{f.name}</span>
                    <span className="block truncate text-[11.5px] text-muted">{f.exists ? formatSize(f.size) : 'Missing'}</span>
                  </span>
                </a>
                <Link to={`/files?path=${encodeURIComponent(parentOf(f.path) || '.')}&file=${encodeURIComponent(f.path)}`}
                  aria-label={`Show ${f.name} in Files`} title="Show in Files"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:w-10">
                  <FolderOpen className="h-3.5 w-3.5" />
                </Link>
                <button type="button" aria-label={`Remove ${f.name} from the task`} title="Remove from the task (the file stays)"
                  onClick={() => detach.mutate(f.path)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:w-10">
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p className="mt-1 text-[12.5px] text-error">{errorMessage(error)}</p>}
      <Lingering value={picking}>
        {() => (
          <Dialog open={picking} onOpenChange={setPicking} title="Attach a file" description="The file stays where it is in Files.">
            <FileFinder start={project ? `projects/${project.slug}` : ''}
              onPick={(entry) => attach.mutate(entry.path, { onSuccess: () => setPicking(false) })} />
            <div className="mt-3 flex justify-end">
              <Button variant="ghost" onClick={() => setPicking(false)}>Cancel</Button>
            </div>
          </Dialog>
        )}
      </Lingering>
    </section>
  )
}
