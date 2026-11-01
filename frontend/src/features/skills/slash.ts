/** Choosing a skill by typing / in the message box. */

export interface SlashSkill {
  id: string
  slug: string
  name: string
  description: string
}

/** What is typed after the slash while the message is only "/…", else null. */
export function slashQuery(text: string): string | null {
  const match = /^\/([\w-]*)$/.exec(text)
  return match ? match[1].toLowerCase() : null
}

/** The skills that fit what was typed after the slash; commands that start with it first. */
export function matchSkills<T extends SlashSkill>(skills: T[], query: string): T[] {
  const q = query.toLowerCase()
  const rank = (s: T) => {
    if (s.slug.startsWith(q)) return 0
    if (s.name.toLowerCase().startsWith(q)) return 1
    if (s.slug.includes(q) || s.name.toLowerCase().includes(q)) return 2
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
 * the Study skill and the text after it. Null when it names no skill.
 */
export function typedCommand<T extends SlashSkill>(skills: T[], text: string): { skill: T; rest: string } | null {
  const match = /^\/([\w-]+)\s([\s\S]*)$/.exec(text)
  if (!match) return null
  const skill = skills.find((s) => s.slug === match[1].toLowerCase())
  return skill ? { skill, rest: match[2].trimStart() } : null
}
