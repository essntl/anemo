import { createContext } from 'react'
import type { CodeJob } from './threads'

/** The job a part of the Code page belongs to: whether it still runs, and where its full log is. */
export interface JobView {
  job: CodeJob
  running: boolean
}

export const JobContext = createContext<JobView | null>(null)
