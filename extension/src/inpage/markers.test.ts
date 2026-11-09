import { describe, expect, it } from 'vitest'
import { apply, blocksInRange, isEditable, pageBlocks, parseTagged, restore, tagged, wordCount } from './markers'

function selectAll(el: Element): Range {
  const range = document.createRange()
  range.selectNodeContents(el)
  return range
}

describe('in-place translation', () => {
  it('replaces and restores text without changing the DOM structure', () => {
    document.body.innerHTML = '<p id="p">Planter gjør <b>lys</b> om til <a href="/x">kjemisk <i>energi</i></a>.<br>Ny linje.</p>'
    const p = document.getElementById('p')!
    const before = p.innerHTML
    const structure = (el: Element) => [...el.querySelectorAll('*')].map((e) => `${e.tagName}${e.getAttribute('href') ?? ''}`).join(',')
    const shape = structure(p)

    const [block] = blocksInRange(selectAll(p))
    expect(tagged(block)).toBe('<1>Planter gjør </1><2>lys</2><3> om til </3><4>kjemisk </4><5>energi</5><6>.</6><7>Ny linje.</7>')
    const applied = apply(block, '<1>Plants turn </1><2>light</2><3> into </3><4>chemical </4><5>energy</5><6>.</6><7>New line.</7>')

    expect(p.textContent).toBe('Plants turn light into chemical energy.New line.')
    expect(structure(p)).toBe(shape) // same elements, same attributes, <br> kept
    expect(p.querySelector('b')!.textContent).toBe('light')
    expect(p.querySelector('a i')!.textContent).toBe('energy')

    restore(applied)
    expect(p.innerHTML).toBe(before)
  })

  it('translates only the selected part of a paragraph', () => {
    document.body.innerHTML = '<p id="p">Keep this. Translate <b>these</b> words. Keep that.</p>'
    const p = document.getElementById('p')!
    const text = p.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 'Keep this. '.length)
    range.setEnd(p.lastChild as Text, ' words.'.length)
    const [block] = blocksInRange(range)
    expect(block.nodes.map((n) => n.data)).toEqual(['Translate ', 'these', ' words.'])
    const applied = apply(block, '<1>Übersetze </1><2>diese</2><3> Wörter.</3>')
    expect(p.textContent).toBe('Keep this. Übersetze diese Wörter. Keep that.')
    restore(applied)
    expect(p.textContent).toBe('Keep this. Translate these words. Keep that.')
  })

  it('splits a selection over several paragraphs into blocks', () => {
    document.body.innerHTML = '<div id="d"><p>One <b>two</b>.</p><ul><li>Three</li><li>Four</li></ul></div>'
    const blocks = blocksInRange(selectAll(document.getElementById('d')!))
    expect(blocks.map((b) => b.element.tagName)).toEqual(['P', 'LI', 'LI'])
    expect(wordCount(blocks)).toBe(4)
  })

  it('keeps each node’s own spacing when the model trims it', () => {
    document.body.innerHTML = '<p id="p">Hallo <b>wereld</b> vandaag</p>'
    const [block] = blocksInRange(selectAll(document.getElementById('p')!))
    apply(block, '<1>Hello</1><2>world</2><3>today</3>')
    expect(document.getElementById('p')!.textContent).toBe('Hello world today')
  })

  it('a translation that lost its markers still lands, as plain text', () => {
    document.body.innerHTML = '<p id="p">Привіт <b>світ</b></p>'
    const p = document.getElementById('p')!
    const [block] = blocksInRange(selectAll(p))
    const applied = apply(block, 'Hello world')
    expect(p.textContent).toBe('Hello world')
    expect(p.querySelector('b')).not.toBeNull() // the element stays (empty)
    restore(applied)
    expect(p.innerHTML).toBe('Привіт <b>світ</b>')
  })

  it('reads markers strictly', () => {
    expect(parseTagged('<2>b</2><1>a</1>', 2)).toEqual(['a', 'b']) // reordered is fine
    expect(parseTagged('<1>a</1>', 2)).toBeNull()
    expect(parseTagged('<1>a</1><1>b</1>', 1)).toBeNull()
    expect(parseTagged('<1>&lt;tag&gt; &amp;</1>', 1)).toEqual(['<tag> &'])
    expect(tagged({ element: document.body, nodes: [document.createTextNode('a < b & c')] })).toBe('<1>a &lt; b &amp; c</1>')
  })

  it('never touches fields, editors or code', () => {
    document.body.innerHTML = '<p id="p">Text <code>let x = 1</code></p><div contenteditable="true" id="e">Draft</div><textarea id="t">x</textarea>'
    const [block] = blocksInRange(selectAll(document.body))
    expect(block.nodes.map((n) => n.data)).toEqual(['Text '])
    expect(isEditable(document.getElementById('e')!.firstChild)).toBe(true)
    expect(isEditable(document.getElementById('p')!.firstChild)).toBe(false)
  })

  it('finds the page’s content blocks, not its menus', () => {
    document.body.innerHTML = '<nav><a>Home</a></nav><article><h1>Title</h1><p>Body <a>link</a></p><ul><li><p>Nested</p></li></ul></article><footer><p>©</p></footer>'
    const blocks = pageBlocks(document.body)
    expect(blocks.map((b) => b.element.tagName)).toEqual(['H1', 'P', 'LI'])
  })
})
