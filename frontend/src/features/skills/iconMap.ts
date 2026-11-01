/**
 * The icons a skill can have. Skills store the icon's kebab-case name (as in the
 * lucide set); unknown names fall back to a sparkle.
 */
import {
  BadgeCheck, BookOpen, Briefcase, Bug, Calculator, ChefHat, Code, Compass, Dumbbell, FileText, GraduationCap,
  Languages, Lightbulb, ListChecks, Mail, Map, MessageSquare, Microscope, Palette, PenLine, Presentation, Puzzle,
  Rocket, Scale, Search, Sparkles, Split, Target, Terminal, WandSparkles, Zap, type LucideIcon,
} from 'lucide-react'

export const SKILL_ICONS: Record<string, LucideIcon> = {
  sparkles: Sparkles,
  'book-open': BookOpen,
  'graduation-cap': GraduationCap,
  map: Map,
  'list-checks': ListChecks,
  scale: Scale,
  'badge-check': BadgeCheck,
  search: Search,
  microscope: Microscope,
  lightbulb: Lightbulb,
  split: Split,
  'pen-line': PenLine,
  'file-text': FileText,
  mail: Mail,
  languages: Languages,
  'message-square': MessageSquare,
  presentation: Presentation,
  code: Code,
  terminal: Terminal,
  bug: Bug,
  calculator: Calculator,
  target: Target,
  compass: Compass,
  rocket: Rocket,
  briefcase: Briefcase,
  palette: Palette,
  puzzle: Puzzle,
  'wand-sparkles': WandSparkles,
  zap: Zap,
  dumbbell: Dumbbell,
  'chef-hat': ChefHat,
}

export const SKILL_ICON_NAMES = Object.keys(SKILL_ICONS)
