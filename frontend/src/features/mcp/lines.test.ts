import { describe, expect, it } from 'vitest'
import { badLines, parseArgs, parsePairs, splitCommand } from './lines'

describe('MCP server dialog text boxes', () => {
  it('reads headers, keeping colons inside the value', () => {
    expect(parsePairs('Authorization: Bearer a:b\n\n X-Team :home ', ':')).toEqual({
      Authorization: 'Bearer a:b',
      'X-Team': 'home',
    })
  })

  it('reads environment variables, keeping equals signs inside the value', () => {
    expect(parsePairs('API_KEY=abc=def\nEMPTY=', '=')).toEqual({ API_KEY: 'abc=def', EMPTY: '' })
  })

  it('points out lines that are not name and value', () => {
    expect(badLines('API_KEY=abc\njust text\n=nothing\n\n', '=')).toEqual(['just text', '=nothing'])
    expect(badLines('Authorization: x', ':')).toEqual([])
  })

  it('reads arguments one per line', () => {
    expect(parseArgs(' -y \n\n@scope/server\n/my files\n')).toEqual(['-y', '@scope/server', '/my files'])
  })

  it('splits a pasted command line into program and arguments', () => {
    expect(splitCommand('npx -y  @scope/server')).toEqual({ command: 'npx', args: ['-y', '@scope/server'] })
    expect(splitCommand('uvx')).toEqual({ command: 'uvx', args: [] })
  })
})
