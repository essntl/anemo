import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { type AllSettings, settingsKey, useSettings } from '@/features/settings/api'
import { normalizeLayout, type WidgetLayout } from './layout'

/**
 * The Home layout from the server, and a way to change it. Changes show at once; they
 * are saved half a second after the last one, so dragging a widget across the grid
 * sends one request, not one per swap.
 */
export function useHomeLayout() {
  const qc = useQueryClient()
  const settings = useSettings()
  const saved = settings.data?.home.layout
  const layout = useMemo(() => normalizeLayout(saved), [saved])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const save = useCallback(
    (next: WidgetLayout[]) => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        const body = { layout: next.map((w) => ({ id: w.id, w: w.w, h: w.h, hidden: !!w.hidden, pinned: !!w.pinned, options: w.options ?? {} })) }
        void api
          .PUT('/api/settings/home', { body })
          .then(unwrap)
          .catch(() => void qc.invalidateQueries({ queryKey: settingsKey }))
      }, 500)
    },
    [qc],
  )
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const update = useCallback(
    (change: (layout: WidgetLayout[]) => WidgetLayout[]) => {
      const current = normalizeLayout(qc.getQueryData<AllSettings>(settingsKey)?.home.layout)
      const next = change(current)
      if (next === current) return
      qc.setQueryData<AllSettings>(settingsKey, (old) =>
        old ? { ...old, home: { layout: next.map((w) => ({ ...w, hidden: !!w.hidden, pinned: !!w.pinned, options: w.options ?? {} })) } } : old,
      )
      save(next)
    },
    [qc, save],
  )
  return { layout, update, ready: settings.isSuccess }
}
