export interface SectionLink {
  to: string
  label: string
  /** Security-sensitive sections show a shield and require re-authentication to change. */
  sensitive?: boolean
}

export const SETTINGS_SECTIONS: SectionLink[] = [
  { to: 'general', label: 'General' },
  { to: 'appearance', label: 'Appearance' },
  { to: 'providers', label: 'Providers & Models', sensitive: true },
  { to: 'permissions', label: 'Agent Permissions', sensitive: true },
  { to: 'workspace', label: 'Workspace', sensitive: true },
  { to: 'web', label: 'Web & Search', sensitive: true },
  { to: 'mcp', label: 'MCP', sensitive: true },
  { to: 'notifications', label: 'Notifications' },
  { to: 'memory', label: 'Memory' },
  { to: 'usage', label: 'Usage' },
  { to: 'advanced', label: 'Advanced' },
]
