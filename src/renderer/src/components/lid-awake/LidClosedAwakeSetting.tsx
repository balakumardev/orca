import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import {
  LID_AWAKE_FLOOR_MAX,
  LID_AWAKE_FLOOR_MIN,
  LID_AWAKE_MAX_HOURS_MAX,
  LID_AWAKE_MAX_HOURS_MIN,
  type LidAwakeActionResult,
  type LidAwakeConfig
} from '../../../../shared/lid-closed-awake'
import {
  NumberField,
  SettingsRow,
  SettingsSwitchRow
} from '../settings/form-controls/SettingsFormControls'
import { SearchableSetting } from '../settings/section-layout/SearchableSetting'
import { LidAwakeSetupDialog } from './LidAwakeSetupDialog'
import { useLidAwakeState } from './use-lid-awake-state'

const isMac = (): boolean => typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

/** macOS only; renders nothing where the main process has no lid-closed controller. */
export function LidClosedAwakeSetting(): React.JSX.Element | null {
  const t = useTranslate()
  const state = useLidAwakeState()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!isMac() || !state) {
    return null
  }
  const { config, setup } = state
  const title = t('lidAwake.title', 'Stay awake with the lid closed')
  const description = t(
    'lidAwake.description',
    'While an agent works in Agent mode, keep this Mac awake even with the lid closed. Needs a one-time admin setup. Stops at the battery limit, when the Mac gets hot, or after the time limit.'
  )

  const report = (result: LidAwakeActionResult): void => {
    // Dismissing the macOS password prompt is a choice, not an error.
    if (!result.ok && !/cancel/i.test(result.error)) {
      toast.error(title, { description: result.error })
    }
  }
  const update = async (patch: Partial<LidAwakeConfig>): Promise<void> => {
    report(await window.api.lidAwake.setConfig(patch))
  }
  const run = async (
    action: () => Promise<LidAwakeActionResult>,
    closeDialog: boolean
  ): Promise<void> => {
    setBusy(true)
    try {
      report(await action())
    } catch {
      toast.error(title)
    }
    setBusy(false)
    if (closeDialog) {
      setDialogOpen(false)
    }
  }
  const runSetup = (): Promise<void> => run(() => window.api.lidAwake.setup(), true)
  const runRemove = (): Promise<void> => run(() => window.api.lidAwake.remove(), false)
  const onToggle = (): void => {
    if (config.enabled) {
      void update({ enabled: false })
    } else if (setup === 'not-installed') {
      setDialogOpen(true)
    } else {
      void update({ enabled: true })
    }
  }

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['awake', 'sleep', 'lid', 'closed', 'battery', 'clamshell', 'caffeinate']}
    >
      <SettingsSwitchRow
        label={title}
        description={description}
        checked={config.enabled}
        onChange={onToggle}
        disabled={busy}
      />
      {config.enabled ? (
        <>
          <NumberField
            label={t('lidAwake.floorLabel', 'Stop at battery level')}
            description={t(
              'lidAwake.floorDescription',
              'On battery power, Orca lets the Mac sleep at or below this level. On AC power there is no limit.'
            )}
            value={config.batteryFloorPercent}
            min={LID_AWAKE_FLOOR_MIN}
            max={LID_AWAKE_FLOOR_MAX}
            integer
            suffix="%"
            onChange={(value) => void update({ batteryFloorPercent: value })}
          />
          <NumberField
            label={t('lidAwake.hoursLabel', 'Stop after')}
            description={t(
              'lidAwake.hoursDescription',
              'The longest one hold may run before Orca lets the Mac sleep.'
            )}
            value={config.maxHoldHours}
            min={LID_AWAKE_MAX_HOURS_MIN}
            max={LID_AWAKE_MAX_HOURS_MAX}
            integer
            suffix="h"
            onChange={(value) => void update({ maxHoldHours: value })}
          />
        </>
      ) : null}
      {setup !== 'not-installed' ? (
        <SettingsRow
          label={t('lidAwake.helperLabel', 'Helper')}
          description={
            setup === 'stale'
              ? t('lidAwake.helperStale', 'A newer helper is available.')
              : t('lidAwake.helperInstalled', 'Installed.')
          }
          control={
            <div className="flex items-center gap-2">
              {setup === 'stale' ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void runSetup()}>
                  {t('lidAwake.helperUpdate', 'Update')}
                </Button>
              ) : null}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void runRemove()}>
                {t('lidAwake.helperRemove', 'Remove')}
              </Button>
            </div>
          }
        />
      ) : null}
      <LidAwakeSetupDialog
        open={dialogOpen}
        busy={busy}
        config={config}
        onOpenChange={setDialogOpen}
        onConfirm={() => void runSetup()}
      />
    </SearchableSetting>
  )
}
