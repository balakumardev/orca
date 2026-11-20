import { defineFixture } from '../../component-fixtures/component-fixture'
import type { ProjectAgentAccountChoice } from '../../../../shared/project-agent-accounts'
import { ProjectAccountSelect } from './ProjectAccountSelect'

const ROSTER = {
  loaded: true,
  accounts: [
    { id: 'work', label: 'bala.kumar@example-company.com' },
    { id: 'personal', label: 'me@example.com' }
  ],
  activeLabel: 'bala.kumar@example-company.com'
}

function Preview({ choice }: { choice: ProjectAgentAccountChoice | undefined }) {
  return (
    <div className="h-[220px] p-3">
      <ProjectAccountSelect
        choice={choice}
        roster={ROSTER}
        onChange={() => {}}
        ariaLabel="Claude account"
      />
    </div>
  )
}

const open = (frame: HTMLElement): void => {
  frame
    .querySelector('[role="combobox"]')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}

export const followNarrow = defineFixture({
  width: 240,
  render: () => <Preview choice={undefined} />
})

export const pinnedNarrow = defineFixture({
  width: 240,
  render: () => <Preview choice={{ kind: 'account', accountId: 'personal' }} />
})

export const openSettingsWidth = defineFixture({
  width: 520,
  render: () => <Preview choice={{ kind: 'system' }} />,
  interact: open
})

export const removedAccountOpen = defineFixture({
  width: 360,
  render: () => <Preview choice={{ kind: 'account', accountId: 'old-account' }} />,
  interact: open
})
