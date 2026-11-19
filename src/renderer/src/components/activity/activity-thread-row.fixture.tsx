import { defineFixture } from '../../component-fixtures/component-fixture'
import { ActivityThreadRow } from './activity-thread-row'
import type { Repo } from '../../../../shared/repo-types'
import type { AgentPaneThread } from './activity-thread-types'

function repo(displayName: string, badgeColor: string): Repo {
  return { id: displayName, path: `/projects/${displayName}`, displayName, badgeColor, addedAt: 0 }
}

function thread(minutesAgo: number, unread: boolean, project: Repo | null): AgentPaneThread {
  return {
    paneKey: `activity-fixture-${minutesAgo}`,
    paneTitle: 'Make the agent activity timestamp easier to scan',
    worktree: {
      id: 'activity-fixture',
      repoId: 'fixture-repo',
      path: '/projects/orca/activity-timestamp',
      head: 'abc123',
      branch: 'activity-timestamp',
      isBare: false,
      isMainWorktree: false,
      displayName: 'Activity timestamp',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    },
    repo: project,
    tab: {
      id: 'fixture-tab',
      ptyId: null,
      worktreeId: 'activity-fixture',
      title: 'Codex',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    },
    agentType: 'codex',
    currentAgentState: 'working',
    currentAgentEntry: null,
    responsePreview: 'Checking the activity card layout in light and dark mode.',
    latestTimestamp: Date.now() - minutesAgo * 60_000,
    latestEvent: null,
    events: [],
    unread
  }
}

function ActivityCards({
  compactMode = false,
  idle = false
}: {
  compactMode?: boolean
  idle?: boolean
}) {
  return (
    <div className="space-y-2 bg-background p-2 text-foreground">
      {[
        thread(2, true, repo('orca', '#0ea5e9')),
        thread(125, false, repo('factors-platform-web', '#f97316')),
        thread(3000, false, null)
      ].map((entry, index) => (
        <ActivityThreadRow
          key={entry.paneKey}
          thread={idle ? { ...entry, currentAgentState: 'idle', unread: false } : entry}
          selected={index === 1}
          compactMode={compactMode}
          canJump
          previewSuppressed
          onSelect={() => {}}
          onJump={() => {}}
          onMarkRead={() => {}}
          onMarkUnread={() => {}}
          onClear={() => {}}
        />
      ))}
    </div>
  )
}

export const full = defineFixture({
  width: 320,
  render: () => <ActivityCards />
})

export const narrowCompact = defineFixture({
  width: 240,
  render: () => <ActivityCards compactMode />
})

export const idlePresence = defineFixture({
  width: 320,
  render: () => <ActivityCards idle />
})
