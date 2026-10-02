import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useProjects, type Project } from '@/features/tasks/api'

/**
 * The project you are working in, chosen with the switcher at the top of the sidebar.
 * `null` means "All projects": every screen shows everything. With a project chosen,
 * chats, tasks, calendar, documents and files show only that project's things, and
 * new ones are created in it. Remembered on this device.
 */
interface ProjectState {
  projectId: string | null
  setProjectId: (id: string | null) => void
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      projectId: null,
      setProjectId: (projectId) => set({ projectId }),
    }),
    { name: 'anemo-project' },
  ),
)

/** The chosen project, or null for "All projects" (also when it was deleted or archived). */
export function useCurrentProject(): Project | null {
  const projectId = useProjectStore((s) => s.projectId)
  const projects = useProjects()
  if (!projectId) return null
  return projects.data?.find((p) => p.id === projectId && !p.archived) ?? null
}
