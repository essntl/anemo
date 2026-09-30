import { createBrowserRouter, Navigate } from 'react-router'
import { PermissionsPage } from '@/features/agents/PermissionsPage'
import { LoginPage } from '@/features/auth/LoginPage'
import { ProvidersPage } from '@/features/providers/ProvidersPage'
import { RequireAuth } from '@/features/auth/RequireAuth'
import { ConversationPage } from '@/features/chat/pages/ConversationPage'
import { NewChatPage } from '@/features/chat/pages/NewChatPage'
import { AppearancePage } from '@/features/settings/pages/AppearancePage'
import { GeneralPage } from '@/features/settings/pages/GeneralPage'
import { SettingsLayout } from '@/features/settings/pages/SettingsLayout'
import { SETTINGS_SECTIONS } from '@/features/settings/sections'
import { AppLayout } from './AppLayout'
import { PlaceholderPage } from './PlaceholderPage'

const placeholder = (path: string, title: string) => ({
  path,
  element: <PlaceholderPage title={title} />,
})

const BUILT_SETTINGS = ['general', 'appearance', 'providers', 'permissions']

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
          { path: 'c/:conversationId', element: <ConversationPage /> },
          placeholder('search', 'Search'),
          placeholder('files', 'Files'),
          placeholder('documents', 'Documents'),
          placeholder('tasks', 'Tasks'),
          placeholder('calendar', 'Calendar'),
          placeholder('runs', 'Runs'),
          placeholder('automations', 'Automations'),
          placeholder('agents', 'Profiles & Skills'),
          placeholder('memory', 'Memory'),
          {
            path: 'settings',
            element: <SettingsLayout />,
            children: [
              { index: true, element: <Navigate to="general" replace /> },
              { path: 'general', element: <GeneralPage /> },
              { path: 'appearance', element: <AppearancePage /> },
              { path: 'providers', element: <ProvidersPage /> },
              { path: 'permissions', element: <PermissionsPage /> },
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
