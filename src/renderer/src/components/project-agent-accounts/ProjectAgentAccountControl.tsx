import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { readIpcErrorMessage } from '@/runtime/errors/ipc-error'
import type {
  ProjectAgentAccountChoice,
  ProjectAgentAccountProvider,
  ProjectAgentAccountSetRequest
} from '../../../../shared/project-agent-accounts'
import type { ProjectAgentAccountRoster } from './project-agent-account-providers'
import {
  getProjectAgentAccountChoice,
  setProjectAgentAccount,
  useProjectAgentAccounts
} from './project-agent-accounts-store'
import { ProjectAccountSelect } from './ProjectAccountSelect'

/** Main refuses a gone project or account with a readable message; show it rather than fail silently. */
export async function saveProjectAgentAccount(
  request: ProjectAgentAccountSetRequest,
  t: Translate
): Promise<void> {
  try {
    await setProjectAgentAccount(request)
  } catch (error) {
    toast.error(t('projectAgentAccounts.saveFailed', 'Could not change the project’s account.'), {
      description: readIpcErrorMessage(error)
    })
  }
}

/** The select bound to one project's saved pin. */
export function ProjectAgentAccountControl({
  repoId,
  provider,
  roster,
  ariaLabel,
  ariaLabelledBy,
  className
}: {
  repoId: string
  provider: ProjectAgentAccountProvider
  roster: ProjectAgentAccountRoster
  ariaLabel?: string
  ariaLabelledBy?: string
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const { snapshot } = useProjectAgentAccounts()
  const [saving, setSaving] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const save = async (choice: ProjectAgentAccountChoice | null): Promise<void> => {
    setSaving(true)
    await saveProjectAgentAccount({ repoId, provider, choice }, t)
    if (mountedRef.current) {
      setSaving(false)
    }
  }

  return (
    <ProjectAccountSelect
      choice={getProjectAgentAccountChoice(snapshot, repoId, provider)}
      roster={roster}
      disabled={saving}
      onChange={(choice) => void save(choice)}
      ariaLabel={ariaLabel}
      ariaLabelledBy={ariaLabelledBy}
      className={className}
    />
  )
}
