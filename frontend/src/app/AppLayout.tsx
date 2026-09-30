import { Outlet } from 'react-router'
import { ReauthDialog } from '@/features/auth/ReauthDialog'
import { useAppEvents } from '@/features/chat/useAppEvents'
import { useAppearanceSync } from '@/features/settings/useAppearanceSync'
import { Sidebar } from './Sidebar'

export function AppLayout() {
  useAppearanceSync()
  useAppEvents()
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
      <ReauthDialog />
    </div>
  )
}
