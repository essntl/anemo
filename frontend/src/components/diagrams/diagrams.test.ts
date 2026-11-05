import { describe, expect, it } from 'vitest'
import { describeChart, formatValue, niceTicks, parseChart } from './chartSpec'
import { FALLBACK_PALETTE } from './colors'
import { fixRequest } from './context'
import { protectDollars } from './dollars'
import { fileName } from './exportImage'
import { isFenceClosed } from './fence'
import { LOCKED_SETTINGS, mermaidConfig } from './mermaidConfig'
import { cleanCss, sanitizeSvg } from './sanitizeSvg'

describe('isFenceClosed', () => {
  it('needs the closing fence of the same kind and length', () => {
    expect(isFenceClosed('```mermaid\ngraph TD\nA-->B\n```')).toBe(true)
    expect(isFenceClosed('```mermaid\ngraph TD\nA-->B\n```\n')).toBe(true)
    expect(isFenceClosed('```mermaid\ngraph TD\nA-->')).toBe(false)
    expect(isFenceClosed('```mermaid')).toBe(false)
    expect(isFenceClosed('````chart\n{}\n```')).toBe(false)
    expect(isFenceClosed('````chart\n{}\n````')).toBe(true)
    expect(isFenceClosed('~~~chart\n{}\n```')).toBe(false)
    expect(isFenceClosed('~~~chart\n{}\n~~~')).toBe(true)
  })

  it('handles blocks in lists and quotes, and indented code', () => {
    expect(isFenceClosed('```chart\n   {}\n   ```')).toBe(true)
    expect(isFenceClosed('```chart\n> {}\n> ```')).toBe(true)
    expect(isFenceClosed('    indented code')).toBe(true)
  })
})

describe('protectDollars', () => {
  it('keeps formulas', () => {
    expect(protectDollars('Energy $E=mc^2$ here')).toBe('Energy $E=mc^2$ here')
    expect(protectDollars('$x$ and $y$')).toBe('$x$ and $y$')
    expect(protectDollars('$$\\int_0^1 x\\,dx$$')).toBe('$$\\int_0^1 x\\,dx$$')
    expect(protectDollars('$$\na^2+b^2\n$$')).toBe('$$\na^2+b^2\n$$')
  })

  it('escapes dollars that are money', () => {
    expect(protectDollars('It costs $5 and $10.')).toBe('It costs \\$5 and \\$10.')
    expect(protectDollars('Between $5-$10 a day')).toBe('Between \\$5-\\$10 a day')
    expect(protectDollars('Only $20')).toBe('Only \\$20')
    expect(protectDollars('Pay $ 5 now')).toBe('Pay \\$ 5 now')
    expect(protectDollars('Prices: $3.50, and $x$ is a variable')).toBe('Prices: \\$3.50, and $x$ is a variable')
  })

  it('leaves code and escaped dollars alone', () => {
    expect(protectDollars('Run `echo $HOME and $PATH`')).toBe('Run `echo $HOME and $PATH`')
    expect(protectDollars('```bash\necho $5 $HOME\n```\nCosts $5')).toBe('```bash\necho $5 $HOME\n```\nCosts \\$5')
    expect(protectDollars('Already \\$5')).toBe('Already \\$5')
    expect(protectDollars('no dollars')).toBe('no dollars')
  })
})

describe('parseChart', () => {
  const ok = { type: 'line', title: 'Visitors', x: ['Mon', 'Tue'], series: [{ name: 'A', values: [1, null] }] }

  it('accepts a valid chart', () => {
    const r = parseChart(JSON.stringify(ok))
    expect(r.error).toBeUndefined()
    expect(r.spec).toEqual({ type: 'line', title: 'Visitors', unit: undefined, x: ['Mon', 'Tue'], series: [{ name: 'A', values: [1, null] }] })
    expect(parseChart(JSON.stringify({ ...ok, x: [2024, 2025] })).spec?.x).toEqual(['2024', '2025'])
  })

  it('explains what is wrong', () => {
    expect(parseChart('{oops').error).toMatch(/not valid JSON/)
    expect(parseChart('[]').error).toMatch(/JSON object/)
    expect(parseChart(JSON.stringify({ ...ok, type: 'radar' })).error).toMatch(/"type" must be one of line, bar, area, pie/)
    expect(parseChart(JSON.stringify({ ...ok, x: [] })).error).toMatch(/"x" must be a list/)
    expect(parseChart(JSON.stringify({ ...ok, series: [] })).error).toMatch(/at least one series/)
    expect(parseChart(JSON.stringify({ ...ok, series: [{ name: 'A', values: [1] }] })).error).toBe('"A" has 1 values for 2 "x" labels.')
    expect(parseChart(JSON.stringify({ ...ok, series: [{ name: 'A', values: [1, 'two'] }] })).error).toMatch(/only contain numbers/)
    expect(parseChart(JSON.stringify({ ...ok, series: [{ values: [1, 2] }] })).error).toMatch(/needs a "name"/)
    expect(parseChart(JSON.stringify({ ...ok, type: 'pie', series: [{ name: 'A', values: [1, -2] }] })).error).toMatch(/negative/)
    expect(parseChart(JSON.stringify({ ...ok, type: 'pie', series: [{ name: 'A', values: [0, 0] }] })).error).toMatch(/above 0/)
  })

  it('formats values and axis ticks', () => {
    expect(formatValue(40, '%')).toBe('40%')
    expect(formatValue(3, 'h')).toBe('3 h')
    expect(formatValue(null)).toBe('–')
    expect(niceTicks(0, 87)).toEqual([0, 20, 40, 60, 80, 100])
    expect(niceTicks(5, 5).length).toBeGreaterThan(1)
    expect(describeChart(parseChart(JSON.stringify(ok)).spec!)).toBe('Line chart "Visitors". A: Mon 1, Tue –.')
  })
})

describe('mermaidConfig', () => {
  it('runs Mermaid in strict mode that a diagram cannot loosen', () => {
    const c = mermaidConfig(FALLBACK_PALETTE)
    expect(c.securityLevel).toBe('strict')
    expect(c.htmlLabels).toBe(false)
    expect(c.startOnLoad).toBe(false)
    for (const key of ['securityLevel', 'htmlLabels', 'themeCSS', 'themeVariables', 'secure', 'flowchart']) {
      expect(c.secure).toContain(key)
    }
    expect(c.secure).toEqual(LOCKED_SETTINGS)
    expect(c.themeVariables?.primaryTextColor).toBe(FALLBACK_PALETTE.text)
    expect(c.themeVariables?.pie1).toBe(FALLBACK_PALETTE.series[0])
  })
})

describe('sanitizeSvg', () => {
  it('keeps the drawing and its styles but nothing that runs or loads', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><style>@import url(https://evil.example/x.css); .a{fill:red;background:url(https://evil.example/t.png)}</style>' +
      '<script>alert(1)</script><g class="a"><rect width="5" height="5" onclick="alert(2)"/>' +
      '<a href="javascript:alert(3)"><text>link</text></a><a href="#inside"><text>ok</text></a>' +
      '<image href="https://evil.example/p.png"/><foreignObject><div>html</div></foreignObject>' +
      '<path marker-end="url(#arrow)" style="fill:url(https://evil.example/f)"/></g></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).toContain('<rect')
    expect(clean).toContain('.a{fill:red')
    expect(clean).toContain('marker-end="url(#arrow)"')
    expect(clean).toContain('href="#inside"')
    expect(clean).not.toMatch(/script|onload|onclick|javascript:|evil\.example|<image|foreignObject|@import/i)
  })

  it('cleans CSS', () => {
    expect(cleanCss('a{background:url("https://x.example/a.png")} b{fill:url(#grad)}')).toBe('a{background:none} b{fill:url(#grad)}')
  })
})

describe('helpers', () => {
  it('names downloads after the title', () => {
    expect(fileName('Visitors per day (2026)', 'chart', 'png')).toBe('visitors-per-day-2026.png')
    expect(fileName(undefined, 'diagram', 'svg')).toBe('diagram.svg')
    expect(fileName('???', 'diagram', 'svg')).toBe('diagram.svg')
  })

  it('writes the fix request with the error', () => {
    const text = fixRequest({ kind: 'mermaid', source: 'graph TD\nA-->', error: 'Parse error on line 2' })
    expect(text).toContain('Mermaid diagram')
    expect(text).toContain('`graph TD`')
    expect(text).toContain('> Parse error on line 2')
    expect(text).toContain('send the whole diagram again, corrected')
  })
})
