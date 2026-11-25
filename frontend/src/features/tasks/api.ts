import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'
import { msg } from '@/lib/i18n'

export type Task = Schemas['TaskOut']
export type TaskInput = Schemas['TaskIn']
export type TaskPatch = Schemas['TaskPatch']
export type TaskStatus = Task['status']
export type Project = Schemas['ProjectOut']

export const tasksKey = ['tasks'] as const
export const projectsKey = ['projects'] as const

/** English texts, marked for translation: show them with `t(STATUS_LABELS[status])`. */
export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: msg('To do'),
  in_progress: msg('In progress'),
  waiting: msg('Waiting'),
  blocked: msg('Blocked'),
  done: msg('Done'),
  cancelled: msg('Cancelled'),
}
export const PRIORITY_LABELS = [msg('No priority'), msg('Low'), msg('Medium'), msg('High')]
/** The colour of a priority's flag, by priority (0–3). */
export const PRIORITY_TONE = ['', 'text-muted', 'text-warning', 'text-error']

/** Every task (open and finished); the page filters and groups them. */
export function useTasks() {
  return useQuery({
    queryKey: [...tasksKey, 'all'],
    queryFn: async () => unwrap(await api.GET('/api/tasks', { params: { query: { status: 'all' } } })),
  })
}

/** Tasks due in a range of days (for the calendar). */
export function useTasksDue(from: string | null, to: string | null) {
  return useQuery({
    queryKey: [...tasksKey, 'due', from, to],
    enabled: Boolean(from && to),
    queryFn: async () =>
      unwrap(await api.GET('/api/tasks', { params: { query: { status: 'all', due_from: from!, due_to: to! } } })),
  })
}

export function useProjects() {
  return useQuery({
    queryKey: projectsKey,
    queryFn: async () => unwrap(await api.GET('/api/projects')),
  })
}

function useRefresh() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: tasksKey })
    void qc.invalidateQueries({ queryKey: projectsKey })
  }
}

export function useCreateTask() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (body: Partial<TaskInput> & { title: string }) =>
      unwrap(
        await api.POST('/api/tasks', {
          body: { description: '', status: 'todo', priority: 0, tags: [], checklist: [], blocked_by: [], ...body },
        }),
      ),
    onSuccess: refresh,
  })
}

export function useUpdateTask() {
  const qc = useQueryClient()
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (v: { id: string; body: TaskPatch }) =>
      unwrap(await api.PATCH('/api/tasks/{task_id}', { params: { path: { task_id: v.id } }, body: v.body })),
    // Show the change at once (ticking a checkbox should feel instant).
    onMutate: (v) => {
      qc.setQueryData<Task[]>([...tasksKey, 'all'], (old) =>
        old?.map((t) => (t.id === v.id ? ({ ...t, ...v.body } as Task) : t)),
      )
    },
    onSettled: refresh,
  })
}

/** Make a synced task an ordinary one (its source fields are cleared). */
export function useDetachTaskSource() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.POST('/api/tasks/{task_id}/detach-source', { params: { path: { task_id: id } } })),
    onSuccess: refresh,
  })
}

export function useDeleteTask() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/tasks/{task_id}', { params: { path: { task_id: id } } })),
    onSuccess: refresh,
  })
}

/** Every task with the tasks of one column put in their new order (and moved to its status). */
export function reorderedTasks(tasks: Task[], status: TaskStatus, orderedIds: string[], now = new Date().toISOString()): Task[] {
  const position = new Map(orderedIds.map((id, i) => [id, i + 1]))
  return tasks.map((task) => {
    const at = position.get(task.id)
    if (at === undefined) return task
    if (task.status === status) return { ...task, sort_order: at }
    return { ...task, status, sort_order: at, completed_at: status === 'done' ? now : null }
  })
}

/**
 * Board: the tasks of one column in their new order. The board shows the move at once;
 * if the server refuses it, the tasks go back to where they were (the caller says why).
 */
export function useReorderTasks() {
  const qc = useQueryClient()
  const refresh = useRefresh()
  const key = [...tasksKey, 'all']
  return useMutation({
    mutationFn: async (v: { status: TaskStatus; orderedIds: string[]; subtasks?: 'finish' | 'keep' }) =>
      unwrap(await api.POST('/api/tasks/reorder', {
        body: { status: v.status, ordered_ids: v.orderedIds, subtasks: v.subtasks ?? null },
      })),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key })
      const before = qc.getQueryData<Task[]>(key)
      if (before) qc.setQueryData<Task[]>(key, reorderedTasks(before, v.status, v.orderedIds))
      return { before }
    },
    onError: (_err, _v, context) => {
      if (context?.before) qc.setQueryData(key, context.before)
    },
    onSettled: refresh,
  })
}

export type ProjectInput = Schemas['ProjectIn']

/** Create a project, or change one. Fields that are left out keep their defaults. */
export function useSaveProject() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (v: Partial<ProjectInput> & { id?: string; name: string }) => {
      const body: ProjectInput = {
        name: v.name,
        color: v.color ?? '#6b7280',
        archived: v.archived ?? false,
        instructions: v.instructions ?? '',
        default_model_id: v.default_model_id ?? null,
        default_profile_id: v.default_profile_id ?? null,
      }
      return v.id
        ? unwrap(await api.PUT('/api/projects/{project_id}', { params: { path: { project_id: v.id } }, body }))
        : unwrap(await api.POST('/api/projects', { body }))
    },
    onSuccess: refresh,
  })
}

export function useDeleteProject() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/projects/{project_id}', { params: { path: { project_id: id } } })),
    onSuccess: refresh,
  })
}
