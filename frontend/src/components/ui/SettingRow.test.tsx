import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { SettingRow, SettingRows } from './SettingRow'

function Tint({ initial = false }: { initial?: boolean }) {
  const [on, setOn] = useState(initial)
  return (
    <SettingRow heading title="Background tint" description="Mixes a color into the page." checked={on} onCheckedChange={setOn}>
      <button type="button">Pick a color</button>
    </SettingRow>
  )
}

describe('SettingRow', () => {
  it('names its switch after the title, and the title flips it too', async () => {
    render(<Tint />)
    const toggle = screen.getByRole('switch', { name: 'Background tint' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(screen.getByText('Background tint'))
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('heading', { name: 'Background tint' })).toBeInTheDocument()
    expect(screen.getByText('Mixes a color into the page.')).toBeInTheDocument()
  })

  it('reveals what the switch turns on, in the same card, and hides it again', async () => {
    render(<Tint />)
    // Folded away: still in the page (so it can animate shut) but out of reach.
    const picker = screen.getByText('Pick a color')
    expect(picker.closest('[inert]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Pick a color' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('switch', { name: 'Background tint' }))
    expect(picker.closest('[inert]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Pick a color' })).toBeInTheDocument()
    expect(picker.closest('[data-open]')).toHaveAttribute('data-open', 'true')

    await userEvent.click(screen.getByRole('switch', { name: 'Background tint' }))
    expect(picker.closest('[inert]')).not.toBeNull()
  })

  it('takes any control, and keeps its content open without a switch', () => {
    render(
      <SettingRows>
        <SettingRow title="Language" control={<select aria-label="Language" />} />
        <SettingRow title="Shortcuts"><p>Always here</p></SettingRow>
      </SettingRows>,
    )
    expect(screen.getByRole('combobox', { name: 'Language' })).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.getByText('Always here').closest('[inert]')).toBeNull()
  })
})
