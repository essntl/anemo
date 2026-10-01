import type { ComponentType } from 'react'
import { createBrowserRouter } from 'react-router'
import { LoginPage } from '@/features/auth/LoginPage'
import { RequireAuth } from '@/features/auth/RequireAuth'
import { ConversationPage } from '@/features/chat/pages/ConversationPage'
import { NewChatPage } from '@/features/chat/pages/NewChatPage'
import { SettingsIndex, SettingsLayout } from '@/features/settings/pages/SettingsLayout'
import { AppLayout } from './AppLayout'
import type { RouteHandle } from './mobileNavStore'
import { RouteError } from './RouteError'

/**
 * Loads a page's code only when it is first opened. Chat is in the main bundle;
 * everything else (the calendar, the document editor, settings, …) arrives when
 * you go there, which keeps the first load small, especially on a phone.
 *
 *   { path: 'files', ...page(() => import('@/features/files/FilesPage'), 'FilesPage') }
 */
function page<Module, Name extends keyof Module>(load: () => Promise<Module>, name: Name) {
  return { lazy: async () => ({ Component: (await load())[name] as ComponentType }) }
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    // Everything below requires a logged-in session.
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      // The agent's browser on its own (a separate window, or a phone): no sidebar.
      { path: 'browser/:conversationId', ...page(() => import('@/features/browser/BrowserPage'), 'BrowserPage') },
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <NewChatPage /> },
          {
            path: 'c/:conversationId',
            element: <ConversationPage />,
            handle: { ownMobileHeader: true } satisfies RouteHandle,
          },
          { path: 'search', ...page(() => import('@/features/search/SearchPage'), 'SearchPage') },
          { path: 'files', ...page(() => import('@/features/files/FilesPage'), 'FilesPage') },
          { path: 'documents', ...page(() => import('@/features/documents/DocumentsPage'), 'DocumentsPage') },
          { path: 'documents/:documentId', ...page(() => import('@/features/documents/DocumentsPage'), 'DocumentsPage') },
          { path: 'tasks', ...page(() => import('@/features/tasks/TasksPage'), 'TasksPage') },
          { path: 'calendar', ...page(() => import('@/features/calendar/CalendarPage'), 'CalendarPage') },
          { path: 'runs', ...page(() => import('@/features/runs/pages/RunsPage'), 'RunsPage') },
          { path: 'runs/:runId', ...page(() => import('@/features/runs/pages/RunDetailPage'), 'RunDetailPage') },
          { path: 'automations', ...page(() => import('@/features/automations/AutomationsPage'), 'AutomationsPage') },
          { path: 'agents', ...page(() => import('@/features/profiles/pages/ProfilesPage'), 'ProfilesPage') },
          { path: 'memory', ...page(() => import('@/features/memory/MemoryPage'), 'MemoryPage') },
          { path: 'notifications', ...page(() => import('@/features/notifications/NotificationsPage'), 'NotificationsPage') },
          {
            path: 'settings',
            element: <SettingsLayout />,
            children: [
              { index: true, element: <SettingsIndex /> },
              { path: 'general', ...page(() => import('@/features/settings/pages/GeneralPage'), 'GeneralPage') },
              { path: 'appearance', ...page(() => import('@/features/settings/pages/AppearancePage'), 'AppearancePage') },
              { path: 'providers', ...page(() => import('@/features/providers/ProvidersPage'), 'ProvidersPage') },
              { path: 'permissions', ...page(() => import('@/features/agents/PermissionsPage'), 'PermissionsPage') },
              { path: 'workspace', ...page(() => import('@/features/files/WorkspaceSettingsPage'), 'WorkspaceSettingsPage') },
              { path: 'web', ...page(() => import('@/features/web/WebSettingsPage'), 'WebSettingsPage') },
              { path: 'mcp', ...page(() => import('@/features/mcp/McpSettingsPage'), 'McpSettingsPage') },
              { path: 'notifications', ...page(() => import('@/features/notifications/NotificationSettingsPage'), 'NotificationSettingsPage') },
              { path: 'memory', ...page(() => import('@/features/memory/MemorySettingsPage'), 'MemorySettingsPage') },
              { path: 'usage', ...page(() => import('@/features/usage/UsagePage'), 'UsagePage') },
              { path: 'advanced', ...page(() => import('@/features/settings/pages/AdvancedPage'), 'AdvancedPage') },
            ],
          },
        ],
      },
    ],
  },
])
