import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { ProjectAgentAccountChoice } from '../../../../shared/project-agent-accounts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import type { ProjectAgentAccountRoster } from './project-agent-account-providers'

// Radix forbids empty values; `:` never occurs in an account id, so these never collide with one.
const FOLLOW_VALUE = 'follow'
const SYSTEM_VALUE = 'system'
const ACCOUNT_VALUE_PREFIX = 'account:'

function choiceValue(choice: ProjectAgentAccountChoice | undefined): string {
  if (!choice) {
    return FOLLOW_VALUE
  }
  return choice.kind === 'system' ? SYSTEM_VALUE : `${ACCOUNT_VALUE_PREFIX}${choice.accountId}`
}

/** null follows the active account (no pin). */
function choiceFromValue(value: string): ProjectAgentAccountChoice | null {
  if (value === SYSTEM_VALUE) {
    return { kind: 'system' }
  }
  return value.startsWith(ACCOUNT_VALUE_PREFIX)
    ? { kind: 'account', accountId: value.slice(ACCOUNT_VALUE_PREFIX.length) }
    : null
}

export type ProjectAccountSelectProps = {
  /** undefined: the project has no pin and follows the active account. */
  choice: ProjectAgentAccountChoice | undefined
  roster: ProjectAgentAccountRoster
  disabled?: boolean
  onChange: (choice: ProjectAgentAccountChoice | null) => void
  ariaLabel?: string
  ariaLabelledBy?: string
  className?: string
}

export function ProjectAccountSelect({
  choice,
  roster,
  disabled,
  onChange,
  ariaLabel,
  ariaLabelledBy,
  className
}: ProjectAccountSelectProps): React.JSX.Element {
  const t = useTranslate()
  const value = choiceValue(choice)
  const options: { value: string; label: string; disabled?: true }[] = [
    {
      value: FOLLOW_VALUE,
      label: roster.loaded
        ? t('projectAgentAccounts.select.followNamed', 'Follow active account ({{account}})', {
            account: roster.activeLabel
          })
        : t('projectAgentAccounts.select.follow', 'Follow active account')
    },
    { value: SYSTEM_VALUE, label: t('projectAgentAccounts.select.system', 'System default') },
    ...roster.accounts.map((account) => ({
      value: `${ACCOUNT_VALUE_PREFIX}${account.id}`,
      label: account.label
    }))
  ]
  if (choice?.kind === 'account' && !options.some((option) => option.value === value)) {
    // Keep a removed account visible so the pin can be read and changed, never picked again.
    options.splice(2, 0, {
      value,
      label: roster.loaded
        ? t('projectAgentAccounts.select.unavailable', '{{account}} (unavailable)', {
            account: choice.accountId
          })
        : choice.accountId,
      disabled: true
    })
  }
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== value) {
          onChange(choiceFromValue(next))
        }
      }}
    >
      <SelectTrigger
        size="sm"
        className={cn('w-full min-w-0', className)}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
      >
        {/* Own child so a long address ends in an ellipsis instead of a cut word. */}
        <SelectValue className="min-w-0">
          <span className="truncate">
            {options.find((option) => option.value === value)?.label}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
