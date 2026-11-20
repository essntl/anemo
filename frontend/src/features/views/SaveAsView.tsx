/** "Save as view": keeps a search (its filters and words) as a view in the sidebar. */
import { useNavigate } from 'react-router'
import { Bookmark } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { useScope } from '@/app/projectStore'
import { Button } from '@/components/ui/Button'
import { promptDialog } from '@/components/ui/dialogs'
import { toast } from '@/components/ui/toast'
import { t } from '@/lib/i18n'
import { useCreateView, type ViewQuery } from './api'

export function SaveAsView({ query }: { query: ViewQuery }) {
  const create = useCreateView()
  const navigate = useNavigate()
  const scope = useScope()
  const save = async () => {
    const name = await promptDialog({ title: t('Save as view'), label: t('Name'), confirmLabel: t('Save'),
      message: t('The view shows every document that matches, now and later, in the sidebar.') })
    if (!name?.trim()) return
    // A view of one project's documents (or made while looking at a project) belongs to it.
    const projectId = query.project_id ?? (scope.kind === 'project' ? scope.project.id : null)
    create.mutate(
      { name: name.trim(), project_id: projectId, pinned: true, query, layout: 'list' },
      { onSuccess: (view) => navigate(`/views/${view.id}`), onError: (err) => toast({ message: errorMessage(err) }) },
    )
  }
  return (
    <Button size="sm" variant="secondary" icon={<Bookmark className="h-3.5 w-3.5" />} loading={create.isPending} onClick={() => void save()}>
      {t('Save as view')}
    </Button>
  )
}
