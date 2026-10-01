/**
 * Documents: a list on the left, the open document on the right. On phones the
 * list and the editor are separate screens (/documents and /documents/:id).
 */
import { useParams } from 'react-router'
import { FileText } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/lib/cn'
import { useDocuments } from './api'
import { DocumentEditor } from './components/DocumentEditor'
import { DocumentList } from './components/DocumentList'

export function DocumentsPage() {
  const { documentId } = useParams()
  const documents = useDocuments()
  const open = documents.data?.documents.find((d) => d.id === documentId)

  return (
    <div className="flex h-full">
      <aside className={cn('w-full shrink-0 border-r border-border md:w-72', documentId && 'hidden md:block')}>
        <DocumentList currentFolder={open?.folder ?? ''} />
      </aside>
      <section className={cn('min-w-0 flex-1', !documentId && 'hidden md:block')}>
        {documentId ? (
          // The key gives every document its own fresh editor state.
          <DocumentEditor key={documentId} id={documentId} />
        ) : (
          <EmptyState icon={<FileText className="h-5 w-5" />} title="Choose a document"
            description="Or create one. Documents are plain Markdown files in your workspace, so agents and other tools can work with them too." />
        )}
      </section>
    </div>
  )
}
