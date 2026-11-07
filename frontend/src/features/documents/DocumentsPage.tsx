/**
 * Documents: a list on the left, the open document on the right. On phones the
 * list and the editor are separate screens (/documents and /documents/:id).
 *
 * A document can also be addressed by its file, /documents/<folder>/<name>.md (as an
 * answer may write it): that opens the document, keeping any #… that points at a part
 * of it.
 */
import { useEffect } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useCurrentProject } from '@/app/projectStore'
import { FileText } from 'lucide-react'
import { api, unwrap } from '@/api/client'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/lib/cn'
import { useDocuments } from './api'
import { documentPathFromAddress } from './passage'
import { DocumentEditor } from './components/DocumentEditor'
import { DocumentList } from './components/DocumentList'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function DocumentByPath({ address }: { address: string }) {
  const navigate = useNavigate()
  const { hash } = useLocation()
  const path = documentPathFromAddress(address)
  const found = useQuery({
    queryKey: ['document-by-path', path],
    queryFn: async () => unwrap(await api.GET('/api/documents/by-path', { params: { query: { path } } })),
    retry: false,
  })
  const id = found.data?.id
  useEffect(() => {
    if (id) navigate(`/documents/${id}${hash}`, { replace: true })
  }, [id, hash, navigate])

  if (!found.isError) return null
  return (
    <div className="p-8 text-[13px]">
      <p className="text-error">There is no document {path}.</p>
      <Link to="/documents" className="mt-2 inline-block text-accent underline">All documents</Link>
    </div>
  )
}

export function DocumentsPage() {
  const params = useParams()
  // /documents/<id>, or /documents/<path> (the "*" route).
  const address = params.documentId ?? params['*'] ?? undefined
  const documentId = address && UUID.test(address) ? address : undefined
  const documents = useDocuments()
  const open = documents.data?.documents.find((d) => d.id === documentId)
  // A project's documents live in the folder documents/<its folder name>/.
  const project = useCurrentProject()

  return (
    <div className="island-reserve flex h-full">
      <aside className={cn('w-full shrink-0 border-r border-border md:w-72', address && 'hidden md:block')}>
        <DocumentList currentFolder={open?.folder ?? project?.slug ?? ''} projectFolder={project?.slug} projectName={project?.name} />
      </aside>
      <section className={cn('min-w-0 flex-1', !address && 'hidden md:block')}>
        {documentId ? (
          // The key gives every document its own fresh editor state.
          <DocumentEditor key={documentId} id={documentId} />
        ) : address ? (
          <DocumentByPath key={address} address={address} />
        ) : (
          <EmptyState icon={<FileText className="h-5 w-5" />} title="Choose a document"
            description="Or create one. Documents are plain Markdown files in your workspace, so agents and other tools can work with them too." />
        )}
      </section>
    </div>
  )
}
