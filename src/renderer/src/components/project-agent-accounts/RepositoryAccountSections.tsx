import type { ComponentProps } from 'react'
import { RepositoryGitHubAccountSection } from '../settings/repository/source-control/RepositoryGitHubAccountSection'
import { ProjectAgentAccountsRepositorySection } from './ProjectAgentAccountsRepositorySection'

/** The GitHub account row and the per-agent account rows of a project's settings, in one slot of the pane. */
export function RepositoryAccountSections(
  props: ComponentProps<typeof RepositoryGitHubAccountSection>
): React.JSX.Element {
  return (
    <>
      <RepositoryGitHubAccountSection {...props} />
      <ProjectAgentAccountsRepositorySection repo={props.repo} forceVisible={props.forceVisible} />
    </>
  )
}
