/**
 * The Home task board's filters (project, tag, when due, lanes by project), kept in the
 * widget's `options` in the Home layout so the board opens as it was left, and the
 * tasks they let through (pure, no React).
 */
import { inScope, type Scope } from '@/app/projectStore'
import type { Project, Task } from '@/features/tasks/api'
import { addDays } from '@/features/tasks/dates'
import { isOpen } from '@/features/tasks/relations'

export type BoardDue = 'all' | 'overdue' | 'week'
const DUES: BoardDue[] = ['all', 'overdue', 'week']

export interface BoardFilters {
  /** null: follow the project switcher; '': every project; else a project's id. */
  project: string | null
  /** '' for every tag. */
  tag: string
  due: BoardDue
  /** One board per project, under each other. */
  lanes: boolean
}

export function readFilters(options: Record<string, string | null> | undefined): BoardFilters {
  const due = options?.due as BoardDue | undefined
  return {
    project: options?.project ?? null,
    tag: options?.tag ?? '',
    due: due && DUES.includes(due) ? due : 'all',
    lanes: options?.lanes === 'project',
  }
}

export function writeFilters(f: BoardFilters): Record<string, string | null> {
  return { project: f.project, tag: f.tag || null, due: f.due === 'all' ? null : f.due, lanes: f.lanes ? 'project' : null }
}

/** The project the board shows ('' for all), and whether it shows only tasks without one. */
export function projectShown(f: BoardFilters, scope: Scope): { projectId: string; unfiled: boolean } {
  return {
    projectId: f.project ?? (scope.kind === 'project' ? scope.project.id : ''),
    unfiled: f.project === null && scope.kind === 'uncategorized',
  }
}

/** The tasks the filters let through. "Overdue": open and due before today; "this week": due in the next seven days, or before. */
export function filterTasks(tasks: Task[], f: BoardFilters, scope: Scope, today: string): Task[] {
  const { projectId, unfiled } = projectShown(f, scope)
  const weekEnd = addDays(today, 7)
  return tasks.filter((t) =>
    (projectId ? t.project_id === projectId : !unfiled || inScope(scope, t.project_id)) &&
    (!f.tag || t.tags.includes(f.tag)) &&
    (f.due === 'all' || (t.due_date !== null && (f.due === 'overdue' ? isOpen(t) && t.due_date < today : t.due_date <= weekEnd))),
  )
}

export interface Lane {
  /** The project's id, or '' for the tasks in none. */
  id: string
  project?: Project
  tasks: Task[]
}

/** Swimlanes: the tasks of each project (in the projects' order), then those in none. Empty lanes are left out. */
export function lanesOf(tasks: Task[], projects: Project[]): Lane[] {
  const lanes: Lane[] = projects.map((project) => ({ id: project.id, project, tasks: tasks.filter((t) => t.project_id === project.id) }))
  const known = new Set(projects.map((p) => p.id))
  lanes.push({ id: '', tasks: tasks.filter((t) => !t.project_id || !known.has(t.project_id)) })
  return lanes.filter((lane) => lane.tasks.length > 0)
}
