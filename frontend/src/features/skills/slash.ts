/** Choosing a skill by typing / in the message box. */
import { msg, t } from '@/lib/i18n'

export interface SlashSkill {
  id: string
  slug: string
  name: string
  description: string
  /** What is typed after the slash in the app's language ("/план"), when that is not the slug. */
  command?: string
  hint?: string
  builtin?: boolean
}

/** A command is letters of any alphabet, digits, - and _. */
const WORD = String.raw`[\p{L}\p{N}_-]`

/**
 * The skills that come with the app, in the app's language: the command (one word, as
 * typed after the slash), the name and the hint. English uses the slug and the server's texts.
 */
const BUILTIN: Record<string, { command: string; name: string; hint: string }> = {
  study: { command: msg('study##command'), name: msg('Study##skill'), hint: msg('Learn a new concept') },
  plan: { command: msg('plan##command'), name: msg('Plan##skill'), hint: msg('Plan a project, task or idea') },
  review: { command: msg('review##command'), name: msg('Review##skill'), hint: msg('Get honest feedback on an idea') },
  'fact-check': { command: msg('fact-check##command'), name: msg('Fact check##skill'), hint: msg('Check a claim or numbers') },
  brainstorm: { command: msg('brainstorm##command'), name: msg('Brainstorm##skill'), hint: msg('Generate ideas and options') },
  decide: { command: msg('decide##command'), name: msg('Decide##skill'), hint: msg('Weigh options and choose') },
  rewrite: { command: msg('rewrite##command'), name: msg('Rewrite##skill'), hint: msg('Make a text clearer and tighter') },
  diagram: { command: msg('diagram##command'), name: msg('Diagram##skill'), hint: msg('Show it as a diagram or chart') },
}

const english = (key: string) => key.split('##')[0]

/**
 * The skills as the current language shows and calls them. A built-in skill gets its
 * command, and its name and hint while they are still the ones it came with (a skill
 * you edited keeps your words). The slug keeps working as a command in every language.
 */
export function localSkills<T extends SlashSkill>(skills: T[]): (T & { command?: string })[] {
  return skills.map((skill) => {
    const own = skill.builtin ? BUILTIN[skill.slug] : undefined
    if (!own) return skill
    return {
      ...skill,
      command: t(own.command).toLowerCase(),
      name: skill.name === english(own.name) ? t(own.name) : skill.name,
      hint: skill.hint === own.hint ? t(own.hint) : skill.hint,
    }
  })
}

/** What can be typed after the slash to call a skill: its command, its slug, and its name written as one word. */
function commandsOf(skill: SlashSkill): string[] {
  return [skill.command ?? skill.slug, skill.slug, skill.name.trim().replace(/\s+/g, '-')].map((c) => c.toLowerCase())
}

/** What is typed after the slash while the message is only "/…", else null. */
export function slashQuery(text: string): string | null {
  const match = new RegExp(`^/(${WORD}*)$`, 'u').exec(text)
  return match ? match[1].toLowerCase() : null
}

/** The skills that fit what was typed after the slash; commands that start with it first. */
export function matchSkills<T extends SlashSkill>(skills: T[], query: string): T[] {
  const q = query.toLowerCase()
  const rank = (s: T) => {
    const commands = commandsOf(s)
    if (commands.some((c) => c.startsWith(q))) return 0
    if (s.name.toLowerCase().startsWith(q)) return 1
    if (commands.some((c) => c.includes(q)) || s.name.toLowerCase().includes(q)) return 2
    if (s.description.toLowerCase().includes(q)) return 3
    return -1
  }
  return skills
    .map((s) => ({ s, r: rank(s) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.s.name.localeCompare(b.s.name))
    .map((x) => x.s)
}

/**
 * A complete command typed (or pasted) at the start: "/study what are objects" becomes
 * the Study skill and the text after it, and so does "/план …" in Ukrainian or Russian, or
 * the name of a skill of your own in any alphabet. Null when it names no skill.
 */
export function typedCommand<T extends SlashSkill>(skills: T[], text: string): { skill: T; rest: string } | null {
  const match = new RegExp(`^/(${WORD}+)\\s([\\s\\S]*)$`, 'u').exec(text)
  if (!match) return null
  const typed = match[1].toLowerCase()
  // The command itself first, so a skill named like another one's command does not take it.
  const skill = skills.find((s) => (s.command ?? s.slug) === typed || s.slug === typed) ?? skills.find((s) => commandsOf(s).includes(typed))
  return skill ? { skill, rest: match[2].trimStart() } : null
}
