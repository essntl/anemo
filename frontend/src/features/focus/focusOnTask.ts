import { useNavigate } from 'react-router'
import { toast } from '@/components/ui/toast'
import { t } from '@/lib/i18n'
import { timerActions } from './timerStore'

/**
 * "Focus on this" (task editor, task menu): start a focus phase for the task. A hook,
 * so the toast's "Open Focus" navigates with the page's router (rather than importing
 * the app's router, which would tie every page with a task menu in a loop with it).
 */
export function useFocusOnTask(): (task: { id: string; title: string }) => void {
  const navigate = useNavigate()
  return (task) => {
    timerActions.focusOn(task.id)
    toast({
      message: t('Focusing on “{title}”', { title: task.title }),
      action: { label: t('Open Focus'), onClick: () => void navigate('/focus') },
    })
  }
}
