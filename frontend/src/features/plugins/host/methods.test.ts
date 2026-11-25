import { describe, expect, it } from 'vitest'
import { checkCall } from './methods'

describe('checkCall', () => {
  it('lets tasks:read list projects, as the server does', () => {
    expect(checkCall('projects.list', {}, ['tasks:read'])).toBeNull()
    expect(checkCall('projects.list', {}, ['projects:read'])).toBeNull()
  })

  it('refuses listing projects without either permission', () => {
    expect(checkCall('projects.list', {}, ['documents:read'])?.code).toBe('permission_denied')
  })
})
