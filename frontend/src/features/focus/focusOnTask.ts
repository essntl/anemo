import { toast } from '@/components/ui/toast'
import { t } from '@/lib/i18n'
import { router } from '@/app/router'
import { timerActions } from './timerStore'

/** "Focus on this" (task editor, task menu): start a focus phase for the task. */
export function focusOnTask(task: { id: string; title: string }): void {
  timerActions.focusOn(task.id)
  toast({
    message: t('Focusing on “{title}”', { title: task.title }),
    action: { label: t('Open Focus'), onClick: () => void router.navigate('/focus') },
  })
}
