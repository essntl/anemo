import { describe, expect, it } from 'vitest'
import { COMMANDS, commandOf, fuzzyRank, matchCommands, matchOptions, parseCommand } from './commands'

describe('chat commands', () => {
  it('parses a command and what follows it', () => {
    expect(parseCommand('/mo')).toEqual({ name: 'mo', arg: null })
    expect(parseCommand('/model gpt 5')).toEqual({ name: 'model', arg: 'gpt 5' })
    expect(parseCommand('hello /model')).toBeNull()
    expect(commandOf(COMMANDS, '/model')).toBeNull() // still a prefix
    expect(commandOf(COMMANDS, '/rename A title')?.arg).toBe('A title')
    expect(commandOf(COMMANDS, '/nope x')).toBeNull()
  })

  it('matches commands by their start first', () => {
    expect(matchCommands(COMMANDS, 'm').map((c) => c.name).slice(0, 2)).toEqual(['model', 'mode'])
    expect(matchCommands(COMMANDS, 'ject').map((c) => c.name)).toEqual(['project'])
  })

  it('ranks options: start, word start, inside, letters in order', () => {
    expect(fuzzyRank('Claude Opus 5.5', 'cla')).toBe(0)
    expect(fuzzyRank('Claude Opus 5.5', 'opus')).toBe(1)
    expect(fuzzyRank('GPT-5.5 mini', 'mini')).toBe(1)
    expect(fuzzyRank('GPT-5.5', '5.5')).toBe(1)
    expect(fuzzyRank('GPT-5.5', 'pt-5')).toBe(2)
    expect(fuzzyRank('GPT-5.5', 'g55')).toBe(3)
    expect(fuzzyRank('GPT-5.5', 'xyz')).toBe(-1)
    const opts = [{ value: 'a', label: 'GPT-5.5' }, { value: 'b', label: 'Claude Opus' }, { value: 'c', label: 'Opus mini' }]
    expect(matchOptions(opts, 'op').map((o) => o.value)).toEqual(['c', 'b'])
    expect(matchOptions(opts, '').map((o) => o.value)).toEqual(['a', 'b', 'c'])
  })
})
