import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'

export type Task = Schemas['TaskOut']
export type TaskInput = Schemas['TaskIn']
export type TaskPatch = Schemas['TaskPatch']
export type TaskStatus = Task['status']
export type Project = Schemas['ProjectOut']

export const tasksKey = ['tasks'] as const
export const projectsKey = ['projects'] as const

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
}
export const PRIORITY_LABELS = ['No priority', 'Low', 'Medium', 'High']

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
          body: { description: '', status: 'todo', priority: 0, tags: [], ...body },
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

export function useDeleteTask() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/tasks/{task_id}', { params: { path: { task_id: id } } })),
    onSuccess: refresh,
  })
}

/** Board: the tasks of one column in their new order. */
export function useReorderTasks() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (v: { status: TaskStatus; orderedIds: string[] }) =>
      unwrap(await api.POST('/api/tasks/reorder', { body: { status: v.status, ordered_ids: v.orderedIds } })),
    onSettled: refresh,
  })
}

export function useSaveProject() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (v: { id?: string; name: string; color: string; archived?: boolean }) => {
      const body = { name: v.name, color: v.color, archived: v.archived ?? false }
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
