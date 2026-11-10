import { useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useProjects, type Project } from '@/features/tasks/api'

/** What is shown while no project is chosen: only what is in no project, or everything. */
export type ScopeView = 'uncategorized' | 'all'

/**
 * What you are looking at, chosen with the switcher at the top of the sidebar:
 *  - Uncategorized (the default): only what is in no project,
 *  - a project: only that project's things, and new ones are created in it,
 *  - All: everything together.
 * `projectId` is the chosen project; while it is `null`, `view` says which of the other
 * two applies. Remembered on this device.
 */
interface ProjectState {
  projectId: string | null
  view: ScopeView
  /** Choose a project. `null` leaves it, back to the view chosen last. */
  setProjectId: (id: string | null) => void
  /** Show Uncategorized or All (and leave the project). */
  setView: (view: ScopeView) => void
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      projectId: null,
      view: 'uncategorized',
      setProjectId: (projectId) => set({ projectId }),
      setView: (view) => set({ projectId: null, view }),
    }),
    { name: 'anemo-project' },
  ),
)

/** The chosen project, or null in Uncategorized and All (also when it was deleted or archived). */
export function useCurrentProject(): Project | null {
  const projectId = useProjectStore((s) => s.projectId)
  const projects = useProjects()
  if (!projectId) return null
  return projects.data?.find((p) => p.id === projectId && !p.archived) ?? null
}

export type Scope = { kind: 'project'; project: Project } | { kind: ScopeView }

/** What the switcher shows: a project, Uncategorized or All. */
export function useScope(): Scope {
  const project = useCurrentProject()
  const view = useProjectStore((s) => s.view)
  return useMemo<Scope>(() => (project ? { kind: 'project', project } : { kind: view }), [project, view])
}

/** Whether something of this project (or of none) belongs to what the switcher shows. */
export function inScope(scope: Scope, projectId: string | null | undefined): boolean {
  if (scope.kind === 'project') return projectId === scope.project.id
  return scope.kind === 'all' || !projectId
}
