import { createContext } from 'react'
import type { AgentInfo } from './agents'

/** A sub-agent of one of the thread's jobs. */
export interface ThreadAgent extends AgentInfo {
  jobId: string
}

/** What the timeline needs to link an Agent call to its sub-agent's own view. */
export interface AgentNav {
  byId: ReadonlyMap<string, ThreadAgent>
  select: (agent: string) => void
}

/** Set while the thread has sub-agents: a Task/Agent call then links to its sub-agent. */
export const AgentNavContext = createContext<AgentNav | null>(null)
