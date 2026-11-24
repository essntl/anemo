import { Monitor, Moon, Sun } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Segmented } from '@/components/ui/Segmented'
import { SettingRow, SettingRows } from '@/components/ui/SettingRow'
import { BackgroundCard } from '@/features/appearance/BackgroundCard'
import { AccentCard, TintCard } from '@/features/appearance/ColorCards'
import { FontCard } from '@/features/appearance/FontCard'
import { DeviceCard, GlassCard, PreviewCard } from '@/features/appearance/MoreCards'
import { type Density, type ThemeMode, useThemeStore } from '../theme'
import { t } from '@/lib/i18n'

/**
 * Settings > Appearance. Every change applies to the whole app at once (the app is the
 * preview) and is saved after a short pause; see features/appearance for how.
 */
export function AppearancePage() {
  const { mode, density, set } = useThemeStore()

  return (
    <div className="flex flex-col gap-(--card-gap)">
      <PreviewCard />

      <Card>
        <SettingRows>
          <SettingRow title={t('Theme')} description={t('Light, dark, or follow your system.')}
            control={
              <Segmented<ThemeMode> label={t('Theme')} value={mode} onChange={(m) => set({ mode: m })}
                options={[
                  { value: 'light', label: <><Sun />{t('Light')}</> },
                  { value: 'dark', label: <><Moon />{t('Dark')}</> },
                  { value: 'system', label: <><Monitor />{t('System')}</> },
                ]} />
            } />
          <SettingRow title={t('Density')}
            description={t('Compact fits more on screen: tighter lists, chats, cards and the sidebar. Touch screens keep finger-sized rows.')}
            control={
              <Segmented<Density> label={t('Density')} value={density} onChange={(d) => set({ density: d })}
                options={[
                  { value: 'comfortable', label: t('Comfortable') },
                  { value: 'compact', label: t('Compact') },
                ]} />
            } />
        </SettingRows>
      </Card>

      <AccentCard />
      <TintCard />
      <FontCard />
      <BackgroundCard />
      <GlassCard />
      <DeviceCard />
    </div>
  )
}
