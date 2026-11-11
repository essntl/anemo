/**
 * Ready-made automations. Picking one only fills in the dialog: nothing runs until
 * it is saved. The name and the prompt are shown (and filled in) in the user's language.
 */
import { msg } from '@/lib/i18n'
import { defaultForm, type ScheduleForm } from './scheduleForm'

export interface AutomationTemplate {
  name: string
  prompt: string
  schedule: ScheduleForm
}

export const TEMPLATES: AutomationTemplate[] = [
  {
    name: msg('Daily summary'),
    prompt: msg('Summarise my day in a few short lines: how long I focused today and on which tasks (use get_focus_stats for today), which tasks I finished, and what is still open and due tomorrow. End with one suggestion for tomorrow. Keep it plain and short; skip any part that has nothing in it.'),
    schedule: { ...defaultForm(), frequency: 'daily', time: '18:00', cron: '0 18 * * *' },
  },
]
