import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type Schemas, unwrap } from '@/api/client'
import { type AllSettings, settingsKey } from '@/features/settings/api'
import { t } from '@/lib/i18n'

export type AppearanceAsset = Schemas['AppearanceAssetOut']
export type AssetKind = AppearanceAsset['kind']

export const assetsKey = ['appearance', 'assets'] as const

/** Everything uploaded for the appearance and the profile, newest first. */
export function useAppearanceAssets(enabled = true) {
  return useQuery({
    queryKey: assetsKey,
    queryFn: async () => unwrap(await api.GET('/api/appearance/assets')),
    enabled,
    staleTime: 5 * 60_000,
  })
}

/** The upload with this id, once the list has loaded. */
export function useAsset(id: string | null | undefined): AppearanceAsset | undefined {
  const assets = useAppearanceAssets(Boolean(id))
  return id ? assets.data?.find((a) => a.id === id) : undefined
}

/** A multipart POST/PUT (the typed client is for JSON); errors as ApiError, like unwrap(). */
async function sendForm<T>(url: string, method: 'POST' | 'PUT', form: FormData): Promise<T> {
  const res = await fetch(url, { method, body: form, credentials: 'same-origin' })
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
  if (!res.ok) {
    throw new ApiError(res.status, body.error?.code ?? `http_${res.status}`, body.error?.message ?? t('Upload failed'))
  }
  return body as T
}

export function useUploadAsset() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ file, kind }: { file: File; kind: 'background' | 'font' }) => {
      const form = new FormData()
      form.append('kind', kind)
      form.append('file', file)
      return sendForm<AppearanceAsset>('/api/appearance/assets', 'POST', form)
    },
    onSuccess: (asset) => qc.setQueryData<AppearanceAsset[]>(assetsKey, (old) => [asset, ...(old ?? [])]),
  })
}

export function useDeleteAsset() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/appearance/assets/{asset_id}', { params: { path: { asset_id: id } } })),
    onSuccess: (_data, id) => {
      qc.setQueryData<AppearanceAsset[]>(assetsKey, (old) => old?.filter((a) => a.id !== id))
      // The server put the settings that used it back to their defaults.
      void qc.invalidateQueries({ queryKey: settingsKey })
    },
  })
}

/** The square to keep, as fractions of the picture (see the server's files.Crop). */
export interface CropBox {
  x: number
  y: number
  size: number
}

function setProfile(qc: ReturnType<typeof useQueryClient>, profile: Schemas['ProfileSettings']) {
  qc.setQueryData<AllSettings>(settingsKey, (old) => (old ? { ...old, profile } : old))
  void qc.invalidateQueries({ queryKey: assetsKey })
}

export function useSetAvatar() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ file, crop }: { file: Blob; crop: CropBox }) => {
      const form = new FormData()
      form.append('file', file, file instanceof File ? file.name : 'avatar')
      form.append('crop_x', String(crop.x))
      form.append('crop_y', String(crop.y))
      form.append('crop_size', String(crop.size))
      return sendForm<Schemas['ProfileSettings']>('/api/appearance/avatar', 'PUT', form)
    },
    onSuccess: (profile) => setProfile(qc, profile),
  })
}

export function useRemoveAvatar() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => unwrap(await api.DELETE('/api/appearance/avatar')),
    onSuccess: (profile) => setProfile(qc, profile),
  })
}

/** Where an upload is served. */
export function assetUrl(id: string, opts: { size?: 64 | 128 | 256; poster?: boolean } = {}): string {
  const base = `/api/appearance/assets/${encodeURIComponent(id)}/content`
  if (opts.poster) return `${base}?variant=poster`
  return opts.size ? `${base}?size=${opts.size}` : base
}
