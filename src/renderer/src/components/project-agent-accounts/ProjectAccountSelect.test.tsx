// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProjectAgentAccountChoice } from '../../../../shared/project-agent-accounts'
import { ProjectAccountSelect } from './ProjectAccountSelect'

afterEach(cleanup)

const ROSTER = {
  loaded: true,
  accounts: [
    { id: 'acct-a', label: 'a@example.com' },
    { id: 'acct-b', label: 'b@example.com' }
  ],
  activeLabel: 'a@example.com'
}

function pick(optionName: string): void {
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Account' }), { key: 'Enter' })
  fireEvent.keyDown(screen.getByRole('option', { name: optionName }), { key: 'Enter' })
}

it('turns each option into the pin it saves, and never offers a removed account', () => {
  const onChange = vi.fn()
  const view = (choice: ProjectAgentAccountChoice | undefined) => (
    <ProjectAccountSelect choice={choice} roster={ROSTER} onChange={onChange} ariaLabel="Account" />
  )
  const { rerender } = render(view(undefined))

  pick('System default')
  rerender(view({ kind: 'system' }))
  pick('b@example.com')
  rerender(view({ kind: 'account', accountId: 'acct-b' }))
  pick('Follow active account (a@example.com)')

  expect(onChange.mock.calls).toEqual([
    [{ kind: 'system' }],
    [{ kind: 'account', accountId: 'acct-b' }],
    [null]
  ])

  rerender(view({ kind: 'account', accountId: 'acct-gone' }))
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Account' }), { key: 'Enter' })
  expect(
    screen.getByRole('option', { name: 'acct-gone (unavailable)' }).getAttribute('aria-disabled')
  ).toBe('true')
})
