import { useRef, useState } from 'react'
import { Image, Link2, Upload } from 'lucide-react'
import { api, errorMessage, unwrap } from '@/api/client'
import { useCurrentProject } from '@/app/projectStore'
import { Button } from '@/components/ui/Button'
import { type Entry, useUpload } from '@/features/files/api'
import { FileFinder } from './FileFinder'
import { IMAGE } from './files'

/**
 * The Files part of "Link to a document or task": pick a workspace file, or upload one
 * (into the project's folder, else files/). An image can go into the text itself.
 */
export function FilesTab({ onLink, onImage }: { onLink: (entry: Entry) => void; onImage?: (entry: Entry) => void }) {
  const project = useCurrentProject()
  const upload = useUpload()
  const input = useRef<HTMLInputElement>(null)
  const [image, setImage] = useState<Entry | null>(null)
  const choose = (entry: Entry) => (onImage && IMAGE.test(entry.name) ? setImage(entry) : onLink(entry))

  const uploadFiles = async (files: File[]) => {
    const folder = unwrap(await api.GET('/api/files/upload-folder', { params: { query: project ? { project_id: project.id } : {} } }))
    const saved = await upload.mutateAsync({ folder, files })
    if (saved[0]) choose(saved[0])
  }

  if (image) {
    return (
      <div className="flex flex-col items-center gap-3 py-2">
        <img src={`/api/files/download?path=${encodeURIComponent(image.path)}`} alt="" className="max-h-40 rounded-lg shadow-soft" />
        <p className="text-[13px] text-muted">{image.name}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" icon={<Image className="h-4 w-4" />} onClick={() => onImage?.(image)}>Show the image in the text</Button>
          <Button icon={<Link2 className="h-4 w-4" />} onClick={() => onLink(image)}>Insert a link</Button>
        </div>
      </div>
    )
  }
  return (
    <div>
      <FileFinder start={project ? `projects/${project.slug}` : ''} onPick={choose} />
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" icon={<Upload className="h-3.5 w-3.5" />} loading={upload.isPending} onClick={() => input.current?.click()}>
          Upload a file
        </Button>
        <span className="text-[12px] text-muted">Goes to {project ? `projects/${project.slug}` : 'files'}/</span>
        <input ref={input} type="file" hidden onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) void uploadFiles(files).catch(() => undefined)
          e.target.value = ''
        }} />
      </div>
      {upload.isError && <p className="mt-1 text-[12.5px] text-error">{errorMessage(upload.error)}</p>}
    </div>
  )
}
