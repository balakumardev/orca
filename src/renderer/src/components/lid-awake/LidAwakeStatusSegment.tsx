import { useEffect, useState } from 'react'
import { Laptop } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { useAppStore } from '@/store/index'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { LidAwakeState } from '../../../../shared/lid-closed-awake'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from '../status-bar/composition/status-bar-context-menu-policy'
import { useLidAwakeState } from './use-lid-awake-state'

const CLOCK_TICK_MS = 30_000

function formatRemaining(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  return hours === 0 ? `${minutes} min` : `${hours} h ${minutes % 60} min`
}

function describe(state: LidAwakeState, now: number, t: Translate): string {
  switch (state.phase) {
    case 'holding': {
      const parts = [t('lidAwake.statusHolding', 'Holding awake with the lid closed')]
      if (state.hasBattery && state.batteryPercent !== null) {
        parts.push(
          t('lidAwake.statusBattery', 'battery {{percent}}%, stops at {{floor}}%', {
            percent: state.batteryPercent,
            floor: state.config.batteryFloorPercent
          })
        )
      }
      if (state.heldUntilMs !== null) {
        parts.push(
          t('lidAwake.statusTimeLeft', '{{time}} left', {
            time: formatRemaining(state.heldUntilMs - now)
          })
        )
      }
      return parts.join(' · ')
    }
    case 'released':
      return state.releaseReason === 'battery-floor'
        ? t('lidAwake.statusReleasedBattery', 'Stopped at the battery limit')
        : state.releaseReason === 'thermal'
          ? t('lidAwake.statusReleasedThermal', 'Stopped because the Mac is hot')
          : state.releaseReason === 'max-hours'
            ? t('lidAwake.statusReleasedTime', 'Stopped at the time limit')
            : t('lidAwake.statusReleasedUser', 'Released until the next agent run')
    case 'needs-setup':
      return t('lidAwake.statusNeedsSetup', 'Needs setup')
    case 'needs-repair':
      return t('lidAwake.statusNeedsRepair', 'Needs repair')
    case 'foreign':
      return t('lidAwake.statusForeign', 'Not holding: sleep is already disabled elsewhere')
    case 'busy':
      return t('lidAwake.statusBusy', 'Not holding: another Orca holds the lid')
    case 'idle':
    case 'off':
      return t('lidAwake.statusIdle', 'Waiting for agents')
  }
}

function toneClass(phase: LidAwakeState['phase']): string {
  if (phase === 'holding' || phase === 'released') {
    return 'text-status-warning-text'
  }
  if (
    phase === 'needs-setup' ||
    phase === 'needs-repair' ||
    phase === 'foreign' ||
    phase === 'busy'
  ) {
    return 'text-destructive'
  }
  return 'text-muted-foreground'
}

export function LidAwakeStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const state = useLidAwakeState()
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const [now, setNow] = useState(() => Date.now())
  const holding = state?.phase === 'holding'
  useEffect(() => {
    if (!holding) {
      return
    }
    setNow(Date.now())
    return installWindowVisibilityInterval({
      run: () => setNow(Date.now()),
      intervalMs: CLOCK_TICK_MS
    })
  }, [holding])

  if (!state || !state.config.enabled) {
    return null
  }
  const title = t('lidAwake.title', 'Stay awake with the lid closed')
  const detail = describe(state, now, t)
  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
              className={`inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-accent/70 hover:text-foreground ${toneClass(state.phase)}`}
              aria-label={`${title}, ${detail}`}
            >
              <Laptop className="size-3" />
              {!iconOnly ? (
                <span className="text-[11px] font-medium">
                  {holding
                    ? t('lidAwake.segmentHolding', 'Lid held')
                    : t('lidAwake.segmentLabel', 'Lid')}
                </span>
              ) : null}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {detail}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        side="top"
        align="end"
        sideOffset={8}
        className="w-72"
      >
        <DropdownMenuLabel>
          <div className="flex flex-col gap-0.5">
            <div>{title}</div>
            <div className="text-[11px] font-normal text-muted-foreground">{detail}</div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {holding ? (
          <DropdownMenuItem onSelect={() => void window.api.lidAwake.releaseNow()}>
            {t('lidAwake.releaseNow', 'Release now (holds again on the next agent run)')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={() => {
            openSettingsTarget({ pane: 'agents', repoId: null })
            openSettingsPage()
          }}
        >
          {t('lidAwake.openSettings', 'Open settings')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
