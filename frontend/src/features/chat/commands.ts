/**
 * Built-in slash commands of the chat composer: `/model gpt`, `/mode agent`, `/rename …`.
 * They change the chat's settings (the same state as the controls under the box) or do
 * something to the chat; none of them sends a message. The composer shows them before
 * the skills when / is typed; the page says which ones it has and runs them.
 */
import { msg } from '@/lib/i18n'

/** How a command takes what follows it. */
export type CommandArg =
  | 'none' // runs at once: /new, /branch
  | 'choice' // one of a list, filtered as you type: /model gpt
  | 'text' // free text, needed: /rename A better title
  | 'optional-text' // free text or nothing: /compact [focus]

export interface CommandSpec {
  name: string
  /** Shown after the command: what it does (a msg(), shown with t()). */
  hint: string
  arg: CommandArg
  /** What to type after it (shown as /rename <title>), for text arguments. */
  placeholder?: string
  /** Changing it makes the model read the whole chat again (no prompt cache). */
  rereads?: boolean
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: 'model', hint: msg('Choose the model for this chat'), arg: 'choice', rereads: true },
  { name: 'effort', hint: msg('How hard the model thinks'), arg: 'choice', rereads: true },
  { name: 'mode', hint: msg('Chat or Agent'), arg: 'choice' },
  { name: 'permissions', hint: msg('The agent profile, with its permissions'), arg: 'choice' },
  { name: 'new', hint: msg('A new chat in the same project, with the same model and mode'), arg: 'none' },
  { name: 'project', hint: msg('Move this chat to a project'), arg: 'choice' },
  { name: 'rename', hint: msg('Give this chat a title'), arg: 'text', placeholder: msg('title') },
  { name: 'branch', hint: msg('Continue in a copy of this chat'), arg: 'none' },
  { name: 'retry', hint: msg('Answer the last message again'), arg: 'none' },
  { name: 'compact', hint: msg('Summarize the chat so far, keeping what you name in detail'), arg: 'optional-text', placeholder: msg('what to keep') },
  { name: 'voice', hint: msg('Dictate the message'), arg: 'none' },
  { name: 'help', hint: msg('Every command and skill'), arg: 'none' },
]

export interface CommandOption {
  value: string
  label: string
  /** Quieter, after the label: "default", "current". */
  detail?: string
}

/** What a page gives the composer to offer and run commands. */
export interface CommandHost {
  /** The commands this chat has now (e.g. no /retry while nothing can be answered again). */
  names: readonly string[]
  /** The choices of a `choice` command. */
  options: (name: string) => CommandOption[]
  /** Run it; the text it returns is said in a small confirmation. A rejected promise keeps the text in the box. */
  run: (name: string, value: string) => string | void | Promise<string | void>
}

/** "/mod" → { name: 'mod', arg: null }; "/model gpt 5" → { name: 'model', arg: 'gpt 5' }; else null. */
export function parseCommand(text: string): { name: string; arg: string | null } | null {
  const match = /^\/([\p{L}\p{N}_-]*)(?:\s([\s\S]*))?$/u.exec(text)
  if (!match) return null
  return { name: match[1].toLowerCase(), arg: match[2] ?? null }
}

/** The commands whose name starts with (then contains) what was typed. */
export function matchCommands(commands: readonly CommandSpec[], query: string): CommandSpec[] {
  const q = query.toLowerCase()
  const starts = commands.filter((c) => c.name.startsWith(q))
  return [...starts, ...commands.filter((c) => !c.name.startsWith(q) && c.name.includes(q))]
}

/** How well `query` matches `label`: 0 starts with it, 1 a word starts with it, 2 contains
 *  it, 3 has its letters in order (gpt5 → "GPT-5.5"); -1 no match. */
export function fuzzyRank(label: string, query: string): number {
  const l = label.toLowerCase()
  const q = query.trim().toLowerCase()
  if (!q) return 0
  if (l.startsWith(q)) return 0
  if (l.split(/[\s/·(-]+/).some((w) => w.startsWith(q))) return 1
  if (l.includes(q)) return 2
  let i = 0
  for (const ch of l) if (ch === q[i]) i += 1
  return i === q.replace(/\s/g, '').length || i === q.length ? 3 : -1
}

/** The options that fit what was typed, best first (stable within a rank). */
export function matchOptions(options: CommandOption[], query: string): CommandOption[] {
  return options
    .map((o, i) => ({ o, i, r: Math.max(fuzzyRank(o.label, query), -1) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.o)
}

/** A command typed in full: "/model " or "/rename x" (not "/model" alone, which may still be a prefix). */
export function commandOf(commands: readonly CommandSpec[], text: string): { spec: CommandSpec; arg: string } | null {
  const parsed = parseCommand(text)
  if (!parsed || parsed.arg === null) return null
  const spec = commands.find((c) => c.name === parsed.name)
  return spec ? { spec, arg: parsed.arg } : null
}
