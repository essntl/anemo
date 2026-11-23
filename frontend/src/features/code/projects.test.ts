import { describe, expect, it } from 'vitest'
import { knownProject, repoName, validProjectName } from './projects'

describe('validProjectName', () => {
  it('takes folder names', () => {
    for (const name of ['anemo', 'my-site_2', 'v1.2', '.github', 'a', 'x'.repeat(100), 'console', 'com10', 'lpt0', 'nulls']) {
      expect(validProjectName(name), name).toBe(true)
    }
  })

  it('refuses paths, dots and odd characters', () => {
    for (const name of ['', '.', '..', '...', 'name.', 'a..', '..\\secrets', 'a/b', 'a b', 'проект', 'x'.repeat(101)]) {
      expect(validProjectName(name), name).toBe(false)
    }
  })

  it('refuses Windows device names, in any case, also with an extension', () => {
    for (const name of ['CON', 'con', 'Prn', 'AUX', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9', 'nul.txt', 'CON.tar.gz', 'Aux.md']) {
      expect(validProjectName(name), name).toBe(false)
    }
  })
})

describe('repoName', () => {
  it('reads the repository name of a remote', () => {
    expect(repoName('https://github.com/essntl/anemo')).toBe('anemo')
    expect(repoName('https://github.com/essntl/anemo.git')).toBe('anemo')
    expect(repoName('https://github.com/essntl/anemo/')).toBe('anemo')
    expect(repoName('git@github.com:essntl/site.git')).toBe('site')
    expect(repoName(null)).toBeUndefined()
    expect(repoName('')).toBeUndefined()
  })
})

describe('knownProject', () => {
  const projects = {
    projects: [{ name: 'anemo-main', dir: 'C:\\dev\\anemo-main', remote: 'https://github.com/essntl/anemo.git' }, { name: 'notes', dir: 'C:\\dev\\notes', remote: null }],
    remote: [{ name: 'site', url: 'https://github.com/essntl/site' }],
    note: null,
  }

  it('knows folders, the repositories folders are clones of, and repositories not cloned', () => {
    expect(knownProject(projects, 'anemo-main')).toBe(true)
    expect(knownProject(projects, 'Notes')).toBe(true)
    // The folder anemo-main is a clone of anemo: the computer resolves that name.
    expect(knownProject(projects, 'anemo')).toBe(true)
    expect(knownProject(projects, 'SITE')).toBe(true)
    expect(knownProject(projects, 'brand-new')).toBe(false)
    expect(knownProject(undefined, 'anemo')).toBe(false)
  })
})
