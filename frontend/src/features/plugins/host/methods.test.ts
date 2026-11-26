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

  it('needs code:read for the projects and git history of a computer', () => {
    for (const method of ['code.projects', 'code.gitGraph', 'code.gitCommit']) {
      expect(checkCall(method, { device: 'PC', project: 'anemo' }, ['code:read'])).toBeNull()
      expect(checkCall(method, { device: 'PC', project: 'anemo' }, ['tasks:read'])?.code).toBe('permission_denied')
    }
  })
})
