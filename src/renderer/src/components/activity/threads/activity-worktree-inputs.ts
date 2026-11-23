import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import type { AllAgentPaneThreadsStoreData } from './use-agent-pane-thread-store-data'

/** Every store field the worktree resolver reads, so a change rebuilds Activity owners. */
export function activityWorktreeInputs(
  storeData: AllAgentPaneThreadsStoreData
): readonly unknown[] {
  return [
    selectWorktreesByRepo(storeData),
    selectFolderWorkspaces(storeData),
    storeData.projectGroups,
    storeData.repos,
    selectDetectedWorktreesByRepo(storeData),
    storeData.floatingWorkspacePath
  ]
}
