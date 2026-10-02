import type { ComponentType } from 'react'
import { createBrowserRouter, type To } from 'react-router'
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

/*
 * Page changes cross-fade (the .page rules in styles/app.css). React Router does this
 * per navigation (`viewTransition: true`), so it is switched on here for all of them,
 * except where it would get in the way:
 *  - the address only changes after the `?` or `#` (tabs, filters, search as you type);
 *  - a dialog, menu or the phone drawer is open: it has its own closing animation, and
 *    the page area would be drawn on top of it during a transition;
 *  - the user asked the system for less motion.
 */
function samePage(to: To | null): boolean {
  if (to === null) return true
  const path = typeof to === 'string' ? to : to.pathname
  if (path === undefined || path === '' || path.startsWith('?') || path.startsWith('#')) return true
  return path.split(/[?#]/)[0] === window.location.pathname
}

const navigate = router.navigate.bind(router)
router.navigate = ((to: To | number | null, options?: Parameters<typeof navigate>[1]) => {
  if (typeof to === 'number') return navigate(to)
  const still =
    samePage(to) ||
    document.querySelector('[role="dialog"]') !== null ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // Links pass `viewTransition: undefined`, so it has to be filled in after their options.
  return navigate(to, still ? options : { ...options, viewTransition: options?.viewTransition ?? true })
}) as typeof router.navigate
