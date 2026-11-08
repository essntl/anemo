import { describe, expect, it } from 'vitest'
import { formatSize } from './format'

/*
 * The three file-size formatters as they were before they were merged into one
 * (refactor/PLAN.md step 5), kept here as the reference the merged one must match.
 */
const before = {
  lib(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  },
  links(bytes: number | null | undefined): string {
    if (bytes == null) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  },
  /** features/files/FilesPage.tsx: one decimal for KB too. */
  filesPage(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  },
}

const SIZES = [0, 1, 512, 1023, 1024, 1500, 1536, 10_000, 12_345, 1_048_575, 1_048_576, 3_565_158, 5_000_000_000]

describe('file sizes', () => {
  it('reads as before in Runs and chat attachments (lib/format.ts)', () => {
    for (const n of SIZES) expect(formatSize(n)).toBe(before.lib(n))
  })

  it('reads as before for task attachments and the file finder (links/files.ts)', () => {
    for (const n of [...SIZES, null, undefined]) expect(formatSize(n)).toBe(before.links(n))
  })

  it('reads as before in the file manager (FilesPage.tsx), with one decimal for KB', () => {
    for (const n of SIZES) expect(formatSize(n, { kbDecimals: 1 })).toBe(before.filesPage(n))
  })
})
