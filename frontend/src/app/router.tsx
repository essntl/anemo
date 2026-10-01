import { createBrowserRouter } from 'react-router'
import { PermissionsPage } from '@/features/agents/PermissionsPage'
import { ProfilesPage } from '@/features/profiles/pages/ProfilesPage'
import { RunDetailPage } from '@/features/runs/pages/RunDetailPage'
import { RunsPage } from '@/features/runs/pages/RunsPage'
import { LoginPage } from '@/features/auth/LoginPage'
import { AutomationsPage } from '@/features/automations/AutomationsPage'
import { DocumentsPage } from '@/features/documents/DocumentsPage'
import { FilesPage } from '@/features/files/FilesPage'
import { WorkspaceSettingsPage } from '@/features/files/WorkspaceSettingsPage'
import { McpSettingsPage } from '@/features/mcp/McpSettingsPage'
import { MemoryPage } from '@/features/memory/MemoryPage'
import { MemorySettingsPage } from '@/features/memory/MemorySettingsPage'
import { NotificationSettingsPage } from '@/features/notifications/NotificationSettingsPage'
import { NotificationsPage } from '@/features/notifications/NotificationsPage'
import { TasksPage } from '@/features/tasks/TasksPage'
import { WebSettingsPage } from '@/features/web/WebSettingsPage'
import { ProvidersPage } from '@/features/providers/ProvidersPage'
import { RequireAuth } from '@/features/auth/RequireAuth'
import { CalendarPage } from '@/features/calendar/CalendarPage'
import { ConversationPage } from '@/features/chat/pages/ConversationPage'
import { NewChatPage } from '@/features/chat/pages/NewChatPage'
import { AppearancePage } from '@/features/settings/pages/AppearancePage'
import { GeneralPage } from '@/features/settings/pages/GeneralPage'
import { SettingsIndex, SettingsLayout } from '@/features/settings/pages/SettingsLayout'
import { SETTINGS_SECTIONS } from '@/features/settings/sections'
import { AppLayout } from './AppLayout'
import type { RouteHandle } from './mobileNavStore'
import { PlaceholderPage } from './PlaceholderPage'

const placeholder = (path: string, title: string) => ({
  path,
  element: <PlaceholderPage title={title} />,
})

const BUILT_SETTINGS = ['general', 'appearance', 'providers', 'permissions', 'workspace', 'web', 'memory', 'notifications', 'mcp']

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    // Everything below requires a logged-in session.
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <NewChatPage /> },
          {
            path: 'c/:conversationId',
            element: <ConversationPage />,
            handle: { ownMobileHeader: true } satisfies RouteHandle,
          },
          placeholder('search', 'Search'),
          { path: 'files', element: <FilesPage /> },
          { path: 'documents', element: <DocumentsPage /> },
          { path: 'documents/:documentId', element: <DocumentsPage /> },
          { path: 'tasks', element: <TasksPage /> },
          { path: 'calendar', element: <CalendarPage /> },
          { path: 'runs', element: <RunsPage /> },
          { path: 'runs/:runId', element: <RunDetailPage /> },
          { path: 'automations', element: <AutomationsPage /> },
          { path: 'agents', element: <ProfilesPage /> },
          { path: 'memory', element: <MemoryPage /> },
          { path: 'notifications', element: <NotificationsPage /> },
          {
            path: 'settings',
            element: <SettingsLayout />,
            children: [
              { index: true, element: <SettingsIndex /> },
              { path: 'general', element: <GeneralPage /> },
              { path: 'appearance', element: <AppearancePage /> },
              { path: 'providers', element: <ProvidersPage /> },
              { path: 'permissions', element: <PermissionsPage /> },
              { path: 'workspace', element: <WorkspaceSettingsPage /> },
              { path: 'web', element: <WebSettingsPage /> },
              { path: 'memory', element: <MemorySettingsPage /> },
              { path: 'mcp', element: <McpSettingsPage /> },
              { path: 'notifications', element: <NotificationSettingsPage /> },
              ...SETTINGS_SECTIONS.filter((s) => !BUILT_SETTINGS.includes(s.to)).map((s) =>
                placeholder(s.to, s.label),
              ),
            ],
          },
        ],
      },
    ],
  },
])
