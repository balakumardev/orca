import React from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { SidebarHeaderActions } from './sidebar-header-actions'
import { SidebarSectionHeader } from '../SidebarSectionHeader'
import { PROJECTS_SECTION_GROUP_KEY } from '../../../../../shared/sidebar-list/sections/group-keys'

type SidebarHeaderProps = {
  onWorkspaceBoardMenuOpenChange: (open: boolean) => void
  /** Only with Bots above it, so the sidebar never folds down to nothing. */
  collapsible?: boolean
  projectsCollapseTarget?: React.Ref<HTMLDivElement>
}

const SidebarHeader = React.memo(function SidebarHeader({
  onWorkspaceBoardMenuOpenChange,
  collapsible = false,
  projectsCollapseTarget
}: SidebarHeaderProps) {
  const t = useTranslate()
  // Subscribe this memoized header to locale changes before using translate().
  useTranslation()
  const groupBy = useAppStore((s) => s.groupBy)
  const projectsCollapsed = useAppStore(
    (s) => collapsible && s.collapsedGroups.has(PROJECTS_SECTION_GROUP_KEY)
  )
  const toggleCollapsedGroup = useAppStore((s) => s.toggleCollapsedGroup)
  const sidebarTitle =
    groupBy === 'repo'
      ? t('dashboard.sidebar.projects', 'Projects')
      : t('dashboard.sidebar.workspaces', 'Workspaces')

  const fold = collapsible
    ? {
        collapsed: projectsCollapsed,
        label: projectsCollapsed
          ? t('sidebar.projectsSection.expand', 'Expand {{title}}', { title: sidebarTitle })
          : t('sidebar.projectsSection.collapse', 'Collapse {{title}}', {
              title: sidebarTitle
            }),
        onToggle: () => toggleCollapsedGroup(PROJECTS_SECTION_GROUP_KEY)
      }
    : undefined

  return (
    <SidebarSectionHeader
      title={sidebarTitle}
      sectionId={groupBy === 'repo' ? 'projects' : 'workspaces'}
      fold={fold}
      tourTarget={groupBy === 'repo' ? 'projects-collapse-all' : undefined}
      // WorktreeList portals the collapse-all toggle here; it owns the rendered project rows.
      titleAccessory={
        <div
          ref={projectsCollapseTarget}
          className="relative flex shrink-0 items-center empty:hidden"
        />
      }
      actions={
        <SidebarHeaderActions onWorkspaceBoardMenuOpenChange={onWorkspaceBoardMenuOpenChange} />
      }
    />
  )
})

export default SidebarHeader
