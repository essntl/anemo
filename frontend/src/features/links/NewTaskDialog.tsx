/**
 * "New task" on a document or an event: a task with the same properties (those tasks
 * can have) and a link back to it. A short form; the task opens in Tasks for the rest.
 */
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field, Input } from '@/components/ui/Input'
import { toast } from '@/components/ui/toast'
import { propertiesFor, useProperties, valuesFor } from '@/features/properties/api'
import { PropertyChips } from '@/features/properties/PropertyChips'
import { useCreateTask } from '@/features/tasks/api'
import { taskLink } from '@/lib/appLinks'
import { t } from '@/lib/i18n'

interface Props {
  /** The reference of the document or event, and its title. */
  from: { ref: string; title: string }
  projectId: string | null
  properties: Record<string, unknown>
  onClose: () => void
}

export function NewTaskDialog({ from, projectId, properties, onClose }: Props) {
  const definitions = useProperties().data ?? []
  const create = useCreateTask()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [values, setValues] = useState<Record<string, unknown>>(properties)
  const available = propertiesFor(definitions, projectId, 'task')
  const submit = () => {
    // Only the values tasks can have go along.
    const { tags, ...rest } = valuesFor(definitions, values, projectId, 'task')
    create.mutate(
      {
        title: title.trim(),
        due_date: due || null,
        project_id: projectId,
        tags: Array.isArray(tags) ? (tags as string[]) : [],
        properties: rest,
        links: [from.ref],
      },
      {
        onSuccess: (task) => {
          onClose()
          toast({ message: t('Task added: {title}', { title: task.title }), action: { label: t('Open'), onClick: () => void navigate(taskLink(task.id)) } })
        },
      },
    )
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t('New task')} className="md:w-[min(94vw,480px)]"
      description={t('It gets the properties of “{title}” and a link back to it.', { title: from.title })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" loading={create.isPending} disabled={!title.trim()} onClick={submit}>{t('Add task')}</Button>
        </>
      }>
      <div className="flex flex-col gap-4">
        <Field label={t('Title')}>
          <Input autoFocus value={title} maxLength={300} placeholder={t('What needs doing?')}
            onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && title.trim() && submit()} />
        </Field>
        <Field label={t('Due date')}>
          <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        {available.length > 0 && (
          <section aria-label={t('Properties')} className="flex flex-wrap items-center gap-1.5">
            <PropertyChips available={available} values={values}
              onChange={(key, value) => {
                setValues((current) => {
                  const next = { ...current }
                  if (value === null) delete next[key]
                  else next[key] = value
                  return next
                })
              }} />
          </section>
        )}
        <p className="text-[12.5px] text-muted">
          {t('Links to')} <Link to={from.ref} className="text-accent hover:underline">{from.title}</Link>
        </p>
        {create.error && <p className="text-[12.5px] text-error">{errorMessage(create.error)}</p>}
      </div>
    </Dialog>
  )
}
