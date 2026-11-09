import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MessageSquare, Settings } from 'lucide-react'
import { storage } from '@/shared/storage'
import { cn } from './lib/cn'
import { useConnection } from './state/connection'
import { SessionProvider } from './state/session'
import { useStored } from './state/useStored'
import { applyAccent } from './theme'
import { ChatView } from './chat/ChatView'
import { ConnectionBanner } from './views/ConnectionBanner'
import { SettingsView } from './views/SettingsView'
import { SetupView } from './views/SetupView'

export type View = 'chat' | 'settings'

/** The query cache for one connection. */
function Connected({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } }))
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const TABS: { view: View; label: string; icon: typeof MessageSquare }[] = [
  { view: 'chat', label: 'Chat', icon: MessageSquare },
  { view: 'settings', label: 'Settings', icon: Settings },
]

export function App() {
  const { connection, loaded, api } = useConnection()
  const accent = useStored('local', 'accent')
  const [view, setView] = useState<View>('chat')

  useEffect(() => applyAccent(accent.value), [accent.value])

  // Reopening the panel shows the view it was left on.
  useEffect(() => {
    void storage.get('session', 'panelState').then((s) => s?.view && setView(s.view as View))
  }, [])
  const go = (next: View) => {
    setView(next)
    void storage.get('session', 'panelState').then((s) => storage.set('session', 'panelState', { conversationId: s?.conversationId ?? null, view: next }))
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
              <span className="max-[360px]:sr-only">{label}</span>
            </button>
          ))}
        </nav>
      </header>
      <ConnectionBanner api={api} />
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {view === 'chat' && <ChatView />}
        {view === 'settings' && <SettingsView api={api} connection={connection} />}
      </main>
    </div>
    </SessionProvider>
    </Connected>
  )
}
