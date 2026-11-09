import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BookmarkPlus, FlaskConical, MessageSquare, NotebookPen, Settings } from 'lucide-react'
import { storage } from '@/shared/storage'
import { cn } from './lib/cn'
import { useConnection } from './state/connection'
import { SessionProvider } from './state/session'
import { useStored } from './state/useStored'
import { applyAccent } from './theme'
import { CaptureView } from './capture/CaptureView'
import { NotesView } from './notes/NotesView'
import { ResearchBar, ResearchView } from './research/ResearchView'
import { ChatView } from './chat/ChatView'
import { ConnectionBanner } from './views/ConnectionBanner'
import { InlineResult } from './views/InlineResult'
import { PanelNotice } from './views/PanelNotice'
import { SettingsView } from './views/SettingsView'
import { SetupView } from './views/SetupView'

export type View = 'chat' | 'capture' | 'notes' | 'research' | 'settings'

/** Shows a chat in the Chat view (e.g. "Explain this moment" from the Notes view). */
async function openChat(conversationId: string): Promise<void> {
  const chat = await storage.get('local', 'chat')
  await storage.set('local', 'chat', { conversationId, drafts: chat?.drafts ?? {} })
  await storage.set('session', 'panelState', { view: 'chat', conversationId })
}

/** The query cache for one connection. */
function Connected({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } }))
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const TABS: { view: View; label: string; icon: typeof MessageSquare }[] = [
  { view: 'chat', label: 'Chat', icon: MessageSquare },
  { view: 'capture', label: 'Capture', icon: BookmarkPlus },
  { view: 'notes', label: 'Notes', icon: NotebookPen },
  { view: 'research', label: 'Research', icon: FlaskConical },
  { view: 'settings', label: 'Settings', icon: Settings },
]

export function App() {
  const { connection, loaded, api } = useConnection()
  const accent = useStored('local', 'accent')
  // The view lives in session storage: reopening the panel shows the one it was left on,
  // and the worker can switch it (a right-click "Save page" opens Capture).
  const panelState = useStored('session', 'panelState')
  const view = (panelState.value?.view as View | undefined) ?? 'chat'

  useEffect(() => applyAccent(accent.value), [accent.value])

  const go = (next: View) => {
    void storage.set('session', 'panelState', { conversationId: panelState.value?.conversationId ?? null, view: next })
  }

  if (!loaded) return null
  if (!connection?.token || !api) return <SetupView connection={connection ?? null} />

  // Keyed by server and token: reconnecting starts with an empty cache.
  return (
    <Connected key={`${connection.serverUrl} ${connection.token}`}>
    <SessionProvider value={{ api, connection: { ...connection, token: connection.token } }}>
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-surface px-2">
        <img src="/icons/icon-32.png" alt="" className="mr-1 h-6 w-6 rounded-md" />
        <nav className="flex flex-1 items-center gap-0.5" aria-label="Views">
          {TABS.map(({ view: v, label, icon: Icon }) => (
            <button
              key={v}
              type="button"
              aria-current={view === v ? 'page' : undefined}
              title={label}
              onClick={() => go(v)}
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-control px-2.5 text-[13px] font-medium',
                view === v ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-text',
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="max-[440px]:sr-only">{label}</span>
            </button>
          ))}
        </nav>
      </header>
      {view !== 'research' && <ResearchBar onOpen={() => go('research')} />}
      <ConnectionBanner api={api} />
      <PanelNotice />
      <InlineResult />
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {view === 'chat' && <ChatView />}
        {view === 'capture' && <CaptureView />}
        {view === 'notes' && <NotesView onOpenChat={(id) => void openChat(id)} />}
        {view === 'research' && <ResearchView onOpenChat={(id) => void openChat(id)} />}
        {view === 'settings' && <SettingsView api={api} connection={connection} />}
      </main>
    </div>
    </SessionProvider>
    </Connected>
  )
}
