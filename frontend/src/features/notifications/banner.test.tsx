import { describe, expect, it, vi } from 'vitest'
import { actionLabel, notificationToast, plainText } from './banner'

describe('the in-app notification banner', () => {
  it('names the action for where the notification leads', () => {
    expect(actionLabel('/c/0190')).toBe('Open chat')
    expect(actionLabel('/code/0190')).toBe('View job')
    expect(actionLabel('/runs/0190')).toBe('View run')
    expect(actionLabel('/settings/notifications')).toBe('Open')
  })

  it('shows the body as plain text, cut to a line or two', () => {
    expect(plainText('## Done\n\n- **Rates** unchanged\n- [EU rules](https://x.test) `new`')).toBe('Done Rates unchanged EU rules new')
    expect(plainText('a'.repeat(300), 50)).toHaveLength(50)
  })

  it('takes the level as the accent, a longer time for problems, and opens the Inbox without a link', () => {
    const open = vi.fn()
    const ok = notificationToast({ id: '1', title: 'Job finished', body: 'All pass.', link: '/code/9', kind: 'agent', level: 'success' }, open)
    expect(ok).toMatchObject({ title: 'Job finished', message: 'All pass.', level: 'success', duration: 10_000, action: { label: 'View job' } })
    ok.action!.onClick()
    expect(open).toHaveBeenCalled()
    const bad = notificationToast({ id: '2', title: 'Price watch failed', body: '', link: null, kind: 'automation', level: 'error' }, open)
    expect(bad).toMatchObject({ level: 'error', duration: 15_000, action: { label: 'Open Inbox' } })
    expect(notificationToast({ id: '3', title: 'x', body: '', link: null, level: 'weird' }, open).level).toBe('info')
  })
})
