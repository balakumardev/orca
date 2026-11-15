import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import type { LidAwakeConfig } from '../../../../shared/lid-closed-awake'

export function LidAwakeSetupDialog(props: {
  open: boolean
  busy: boolean
  config: LidAwakeConfig
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { open, busy, config, onOpenChange, onConfirm } = props
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t('lidAwake.setupTitle', 'Set up lid-closed awake')}</DialogTitle>
          <DialogDescription size="compact">
            <span className="flex flex-col gap-2">
              <span>
                {t(
                  'lidAwake.setupAdmin',
                  'macOS asks for your password or Touch ID once. Orca installs a small helper that can turn Mac sleep off and on, and nothing else.'
                )}
              </span>
              <span>
                {t(
                  'lidAwake.setupWarmth',
                  'A Mac kept awake in a bag runs warm and drains its battery. Orca stops on its own at {{floor}}% battery (on battery power), when the Mac gets hot, or after {{hours}} hours.',
                  { floor: config.batteryFloorPercent, hours: config.maxHoldHours }
                )}
              </span>
              <span>
                {t(
                  'lidAwake.setupAgentMode',
                  'It only holds while an agent is working and the Keep computer awake setting is on Agent.'
                )}
              </span>
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('lidAwake.cancel', 'Cancel')}
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            {t('lidAwake.setupConfirm', 'Set up and turn on')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
