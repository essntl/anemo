/**
 * The floating toolbar of the sketch canvas: the tools, the colour and size, undo and
 * redo, deleting the selection and the sheet's settings. It scrolls sideways when the
 * screen is too narrow for it.
 */
import { useState, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import {
  ArrowUpRight, Check, Circle, Eraser, FilePlus, Grid3x3, Hand, Highlighter, Lasso, Minus, Pen, Pointer, Redo2, Rows3,
  Settings2, Slash, Square, Grip, Trash, Type, Undo2,
} from 'lucide-react'
import { Segmented } from '@/components/ui/Segmented'
import { Switch } from '@/components/ui/Switch'
import { shortcutText, type ShortcutId } from '@/features/shortcuts/registry'
import { cn } from '@/lib/cn'
import { msg, plural, t } from '@/lib/i18n'
import { INK, LIMITS, type SketchBackground, type SketchData, type SketchLayout } from '../model'
import type { EraseMode } from './eraser'
import { PALETTE } from './palette'
import { colorSlot, SIZES, sizeGroup, type ToolStyle } from './toolStyle'
import type { ToolId } from './tools/types'

export type SheetSettings = Pick<SketchData, 'layout' | 'background' | 'pages'>

export interface SketchToolbarProps {
  tool: ToolId
  onTool: (tool: ToolId) => void
  style: ToolStyle
  onStyle: (style: ToolStyle) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  hasSelection: boolean
  onDeleteSelection: () => void
  sheet: SheetSettings
  onSheet: (change: Partial<SheetSettings>) => void
  fingerDraws: boolean
  onFingerDraws: (on: boolean) => void
  className?: string
}

interface ToolInfo {
  id: ToolId
  label: string
  icon: ReactNode
  shortcut?: ShortcutId
}

const MAIN_TOOLS: ToolInfo[] = [
  { id: 'pen', label: msg('Pen'), icon: <Pen />, shortcut: 'sketch.pen' },
  { id: 'highlighter', label: msg('Highlighter'), icon: <Highlighter />, shortcut: 'sketch.highlighter' },
  { id: 'eraser', label: msg('Eraser'), icon: <Eraser />, shortcut: 'sketch.eraser' },
  { id: 'select', label: msg('Select'), icon: <Lasso />, shortcut: 'sketch.select' },
]

const SHAPE_TOOLS: ToolInfo[] = [
  { id: 'line', label: msg('Line'), icon: <Slash />, shortcut: 'sketch.line' },
  { id: 'arrow', label: msg('Arrow'), icon: <ArrowUpRight />, shortcut: 'sketch.arrow' },
  { id: 'rect', label: msg('Rectangle'), icon: <Square />, shortcut: 'sketch.rect' },
  { id: 'ellipse', label: msg('Ellipse'), icon: <Circle />, shortcut: 'sketch.ellipse' },
]

const LAST_TOOLS: ToolInfo[] = [
  { id: 'text', label: msg('Text'), icon: <Type />, shortcut: 'sketch.text' },
  { id: 'hand', label: msg('Move around'), icon: <Hand /> },
]

const BACKGROUNDS: { value: SketchBackground; label: string; icon: ReactNode }[] = [
  { value: 'plain', label: msg('Plain'), icon: <Square /> },
  { value: 'grid', label: msg('Grid'), icon: <Grid3x3 /> },
  { value: 'dots', label: msg('Dots'), icon: <Grip /> },
  { value: 'lines', label: msg('Lines'), icon: <Rows3 /> },
]

const BUTTON =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:pointer-events-none disabled:opacity-35 pointer-coarse:h-10 pointer-coarse:w-10 [&_svg]:h-[18px] [&_svg]:w-[18px]'
const ON = 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent'

const Divider = () => <span aria-hidden className="mx-1 h-6 w-px shrink-0 bg-border" />

/** The tooltip of a button: its name and, when it has one, its key. */
const titleOf = (label: string, shortcut?: ShortcutId) => (shortcut ? `${label} (${shortcutText(shortcut)})` : label)

function ToolButton({ info, active, onClick }: { info: ToolInfo; active: boolean; onClick: () => void }) {
  const label = t(info.label)
  return (
    <button type="button" aria-label={label} title={titleOf(label, info.shortcut)} aria-pressed={active} onClick={onClick}
      className={cn(BUTTON, active && ON)}>
      {info.icon}
    </button>
  )
}

/** A toolbar button that opens a small panel under it. */
function PanelButton({ label, title, active, trigger, children }: { label: string; title?: string; active?: boolean; trigger: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" aria-label={label} title={title ?? label} className={cn(BUTTON, (open || active) && ON)}>
          {trigger}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="center" sideOffset={8} collisionPadding={8}
          className="pop z-50 w-[min(18rem,calc(100vw-1rem))] rounded-card border border-border bg-card p-3 shadow-float">
          <div role="group" aria-label={label} className="flex flex-col gap-3">{children}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

const SectionTitle = ({ children }: { children: ReactNode }) => <div className="text-[11.5px] font-semibold uppercase tracking-wider text-muted">{children}</div>

/** A round sample of a colour; "ink" is the theme's text colour. */
function ColorDot({ color, className }: { color: string; className?: string }) {
  return (
    <span aria-hidden className={cn('block rounded-full ring-1 ring-border-strong', color === INK && 'bg-text', className)}
      style={color === INK ? undefined : { background: color }} />
  )
}

function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const custom = !PALETTE.some((s) => s.color === value)
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>{t('Colour')}</SectionTitle>
      <div role="radiogroup" aria-label={t('Colour')} className="flex flex-wrap gap-1.5">
        {PALETTE.map((swatch) => {
          const chosen = swatch.color === value
          return (
            <button key={swatch.color} type="button" role="radio" aria-checked={chosen} aria-label={t(swatch.label)} title={t(swatch.label)}
              onClick={() => onChange(swatch.color)}
              className={cn('relative flex h-8 w-8 items-center justify-center rounded-full pointer-coarse:h-10 pointer-coarse:w-10',
                chosen ? 'ring-2 ring-accent ring-offset-2 ring-offset-card' : 'hover:scale-110 transition-transform')}>
              <ColorDot color={swatch.color} className="h-6 w-6" />
              {chosen && <Check aria-hidden className="absolute h-3.5 w-3.5 text-white mix-blend-difference" strokeWidth={3} />}
            </button>
          )
        })}
      </div>
      <label className="flex items-center gap-2 text-[13px] text-muted">
        <input type="color" aria-label={t('Your own colour')} value={custom ? value : '#1c7ed6'} onChange={(e) => onChange(e.target.value.toLowerCase())}
          className={cn('color-input h-8 w-8 shrink-0 pointer-coarse:h-10 pointer-coarse:w-10', custom && 'ring-2 ring-accent ring-offset-2 ring-offset-card')} />
        {t('Your own colour')}
      </label>
    </div>
  )
}

/** Colour, size and (for the eraser) what it erases, for the chosen tool. */
function StylePanel({ tool, style, onStyle }: { tool: ToolId; style: ToolStyle; onStyle: (s: ToolStyle) => void }) {
  const slot = colorSlot(tool)
  const group = sizeGroup(tool)
  return (
    <>
      {slot && <ColorPicker value={style.colors[slot]} onChange={(color) => onStyle({ ...style, colors: { ...style.colors, [slot]: color } })} />}
      {group && (
        <div className="flex flex-col gap-2">
          <SectionTitle>{group === 'text' ? t('Text size') : t('Size')}</SectionTitle>
          <Segmented label={group === 'text' ? t('Text size') : t('Size')} size="sm" className="w-full"
            value={String(style.sizes[group])}
            onChange={(v) => onStyle({ ...style, sizes: { ...style.sizes, [group]: Number(v) } })}
            options={SIZES[group].map((preset, i) => ({
              value: String(preset.value),
              ariaLabel: t(preset.label),
              label: group === 'text'
                ? <span style={{ fontSize: 11 + i * 2 }} className="font-semibold">A</span>
                : <span aria-hidden className="block rounded-full bg-current" style={{ width: 4 + i * 4, height: 4 + i * 4 }} />,
            }))} />
        </div>
      )}
      {tool === 'eraser' && (
        <div className="flex flex-col gap-2">
          <SectionTitle>{t('Erase')}</SectionTitle>
          <Segmented<EraseMode> label={t('Erase')} size="sm" className="w-full" value={style.eraseMode}
            onChange={(eraseMode) => onStyle({ ...style, eraseMode })}
            options={[{ value: 'whole', label: t('Whole strokes') }, { value: 'partial', label: t('Parts of strokes') }]} />
        </div>
      )}
    </>
  )
}

function SheetPanel({ sheet, onSheet, fingerDraws, onFingerDraws }: Pick<SketchToolbarProps, 'sheet' | 'onSheet' | 'fingerDraws' | 'onFingerDraws'>) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <SectionTitle>{t('Layout')}</SectionTitle>
        <Segmented<SketchLayout> label={t('Layout')} size="sm" className="w-full" value={sheet.layout} onChange={(layout) => onSheet({ layout })}
          options={[{ value: 'infinite', label: t('Endless sheet') }, { value: 'pages', label: t('Pages') }]} />
      </div>
      {sheet.layout === 'pages' && (
        <div className="flex items-center justify-between gap-2 text-[13px]">
          <span className="text-muted">{plural(sheet.pages, '{n} page', '{n} pages')}</span>
          <div className="flex items-center gap-1">
            <button type="button" className={BUTTON} aria-label={t('Remove the last page')} title={t('Remove the last page')}
              disabled={sheet.pages <= 1} onClick={() => onSheet({ pages: sheet.pages - 1 })}>
              <Minus />
            </button>
            <button type="button" className={BUTTON} aria-label={t('Add a page')} title={t('Add a page')}
              disabled={sheet.pages >= LIMITS.pages} onClick={() => onSheet({ pages: sheet.pages + 1 })}>
              <FilePlus />
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <SectionTitle>{t('Background')}</SectionTitle>
        <Segmented<SketchBackground> label={t('Background')} size="sm" className="w-full" value={sheet.background} onChange={(background) => onSheet({ background })}
          options={BACKGROUNDS.map((b) => ({ value: b.value, label: b.icon, ariaLabel: t(b.label) }))} />
      </div>
      <label className="flex items-center justify-between gap-3 text-[13px]">
        <span className="flex items-center gap-2"><Pointer aria-hidden className="h-4 w-4 text-muted" />{t('Draw with finger')}</span>
        <Switch checked={fingerDraws} onChange={onFingerDraws} label={t('Draw with finger')} />
      </label>
    </>
  )
}

export function SketchToolbar(props: SketchToolbarProps) {
  const { tool, onTool, style, onStyle, canUndo, canRedo, onUndo, onRedo, hasSelection, onDeleteSelection, sheet, onSheet, className } = props
  const shape = SHAPE_TOOLS.find((s) => s.id === tool) ?? SHAPE_TOOLS[0]
  const shapeActive = SHAPE_TOOLS.some((s) => s.id === tool)
  const slot = colorSlot(tool)
  const hasStyle = slot !== null || sizeGroup(tool) !== null
  return (
    <div role="toolbar" aria-label={t('Drawing tools')}
      className={cn('flex max-w-full flex-wrap items-center justify-center gap-0.5 rounded-panel border border-border bg-card p-1 shadow-float', className)}>
      {MAIN_TOOLS.map((info) => <ToolButton key={info.id} info={info} active={tool === info.id} onClick={() => onTool(info.id)} />)}
      <PanelButton label={t('Shapes')} title={t('Shapes')} active={shapeActive} trigger={shape.icon}>
        <SectionTitle>{t('Shapes')}</SectionTitle>
        <div className="grid grid-cols-4 gap-1">
          {SHAPE_TOOLS.map((info) => <ToolButton key={info.id} info={info} active={tool === info.id} onClick={() => onTool(info.id)} />)}
        </div>
        <p className="text-[12px] text-muted">{t('Hold Shift for a square, a circle or a line at 45°.')}</p>
      </PanelButton>
      {LAST_TOOLS.map((info) => <ToolButton key={info.id} info={info} active={tool === info.id} onClick={() => onTool(info.id)} />)}
      {hasStyle && (
        <>
          <Divider />
          <PanelButton label={t('Colour and size')} trigger={slot ? <ColorDot color={style.colors[slot]} className="h-5 w-5" /> : <Circle />}>
            <StylePanel tool={tool} style={style} onStyle={onStyle} />
          </PanelButton>
        </>
      )}
      <Divider />
      <button type="button" className={BUTTON} aria-label={t('Undo')} title={titleOf(t('Undo'), 'sketch.undo')} disabled={!canUndo} onClick={onUndo}><Undo2 /></button>
      <button type="button" className={BUTTON} aria-label={t('Redo')} title={titleOf(t('Redo'), 'sketch.redo')} disabled={!canRedo} onClick={onRedo}><Redo2 /></button>
      {hasSelection && (
        <button type="button" className={cn(BUTTON, 'hover:text-error')} aria-label={t('Delete what is selected')} title={titleOf(t('Delete what is selected'), 'sketch.delete')}
          onClick={onDeleteSelection}>
          <Trash />
        </button>
      )}
      <Divider />
      {sheet.layout === 'pages' && (
        <button type="button" className={BUTTON} aria-label={t('Add a page')} title={t('Add a page')} disabled={sheet.pages >= LIMITS.pages}
          onClick={() => onSheet({ pages: sheet.pages + 1 })}>
          <FilePlus />
        </button>
      )}
      <PanelButton label={t('Sheet settings')} trigger={<Settings2 />}>
        <SheetPanel sheet={sheet} onSheet={onSheet} fingerDraws={props.fingerDraws} onFingerDraws={props.onFingerDraws} />
      </PanelButton>
    </div>
  )
}
