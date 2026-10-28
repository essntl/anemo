import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { type AllSettings, settingsKey, useSettings } from '@/features/settings/api'
import { layoutFor, type WidgetLayout } from './layout'

const toSaved = (layout: WidgetLayout[]) =>
  layout.map((w) => ({ id: w.id, w: w.w, h: w.h, hidden: !!w.hidden, pinned: !!w.pinned, options: w.options ?? {} }))

/**
 * The Home layout from the server for this screen (phone or wider), and a way to
 * change it. Changes show at once; they are saved half a second after the last one,
 * so dragging a widget across the grid sends one request, not one per swap.
 */
export function useHomeLayout() {
  const qc = useQueryClient()
  const settings = useSettings()
  const phone = !useMediaQuery(DESKTOP)
  const home = settings.data?.home
  const layout = useMemo(() => layoutFor(home, phone), [home, phone])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The section is saved whole, so both layouts go along (as they are by then).
  const save = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      const current = qc.getQueryData<AllSettings>(settingsKey)?.home
      if (!current) return
      const body = { layout: current.layout ?? [], mobile_layout: current.mobile_layout ?? [] }
      void api
        .PUT('/api/settings/home', { body })
        .then(unwrap)
        .catch(() => void qc.invalidateQueries({ queryKey: settingsKey }))
    }, 500)
  }, [qc])
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const update = useCallback(
    (change: (layout: WidgetLayout[]) => WidgetLayout[]) => {
      const old = qc.getQueryData<AllSettings>(settingsKey)
      if (!old) return
      const current = layoutFor(old.home, phone)
      const next = change(current)
      if (next === current) return
      qc.setQueryData<AllSettings>(settingsKey, {
        ...old,
        home: { ...old.home, [phone ? 'mobile_layout' : 'layout']: toSaved(next) },
      })
      save()
    },
    [qc, save, phone],
  )
  return { layout, update, ready: settings.isSuccess, phone }
}
