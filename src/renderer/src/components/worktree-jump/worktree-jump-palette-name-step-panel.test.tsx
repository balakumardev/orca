// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WorktreeJumpPaletteNameStepPanel } from './worktree-jump-palette-name-step-panel'
import { WorktreeJumpPaletteProjectCreateHint } from './worktree-jump-palette-project-create-hint'

afterEach(cleanup)

describe('The name step panel', () => {
  it('names the project and shows its folder, so two projects with one title can be told apart', () => {
    const { container } = render(
      <WorktreeJumpPaletteNameStepPanel
        step={{
          repoId: 'r-1',
          projectLabel: 'notes',
          projectPath: '/work/clients/notes',
          name: ''
        }}
      />
    )
    const panel = container.querySelector('[data-slot="palette-project-name-step"]')

    expect(panel?.textContent).toBe(
      'New worktree in notes/work/clients/notesSame as Create in the New worktree dialog.'
    )
    expect(container.textContent).toContain('Create worktree')
    expect(container.textContent).toContain('Back')
  })
})

describe('The footer hints', () => {
  it('name the project each chord acts on, and show only the chords that have one', () => {
    const both = render(
      <WorktreeJumpPaletteProjectCreateHint
        modKey="Cmd"
        rowProjectLabel="acme-web"
        currentProjectLabel="notes"
      />
    )
    expect(both.container.textContent).toBe(
      'Cmd+EnterNew worktree in acme-webCmd+Shift+EnterNew worktree in notes'
    )
    cleanup()

    const rowOnly = render(
      <WorktreeJumpPaletteProjectCreateHint
        modKey="Cmd"
        rowProjectLabel="acme-web"
        currentProjectLabel={null}
      />
    )
    expect(rowOnly.container.textContent).toBe('Cmd+EnterNew worktree in acme-web')
    cleanup()

    const none = render(
      <WorktreeJumpPaletteProjectCreateHint
        modKey="Cmd"
        rowProjectLabel={null}
        currentProjectLabel={null}
      />
    )
    expect(none.container.textContent).toBe('')
  })

  it('truncates a long project name instead of widening the footer', () => {
    const { container } = render(
      <WorktreeJumpPaletteProjectCreateHint
        modKey="Cmd"
        rowProjectLabel={'x'.repeat(200)}
        currentProjectLabel={null}
      />
    )
    expect(container.querySelector('span.truncate')?.className).toContain('max-w-[16rem]')
  })
})
