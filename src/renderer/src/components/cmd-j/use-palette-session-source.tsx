import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { useChatProgramFactsVersion } from '@/lib/agent-session/launch/inventory/host-chat-program-acquisition'
import { recomputeOn } from '@/lib/recompute-on'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo,
  selectDetectedWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import type { PaletteExtraSource } from './palette-extra-results'
import { resolvePaletteSessionAction } from './palette-session-action'
import { readPaletteSessionFacts } from './palette-session-facts'
import { openPaletteSession } from './palette-session-open'
import {
  buildSessionPaletteResults,
  paletteSessionHitId,
  paletteSessionTitle
} from './palette-session-results'
import { PaletteSessionLeading, PaletteSessionLine } from './palette-session-row-parts'
import { SESSION_SOURCE_ID } from './palette-session-source-id'
import { usePaletteSessionResumeCatalogs } from './use-palette-session-resume-catalogs'
import { usePaletteSessionSearch } from './use-palette-session-search'

const NO_STORE_INPUTS = null

/**
 * Connected computers search their own opted-in history indexes. Rows carry no
 * rank, so they never lead the list, and they are never armed by a typed Enter (see palette-folder-selection).
 */
export function usePaletteSessionSource({
  query,
  visible,
  hostIds,
  repoIds
}: {
  query: string
  visible: boolean
  hostIds?: readonly string[]
  repoIds?: readonly string[]
}): PaletteExtraSource | null {
  const t = useTranslate()
  const { active, hits } = usePaletteSessionSearch({ query, visible, hostIds, repoIds })
  const hosts = useMemo(
    () => [...new Map(hits.map((hit) => [hit.searchHost.key, hit.searchHost])).values()],
    [hits]
  )
  const catalogVersion = usePaletteSessionResumeCatalogs(active, hosts)
  const hasHits = hits.length > 0
  // What a row's action depends on. Watched only while rows are on screen: agent status changes constantly.
  const storeInputs = useAppStore(
    useShallow((state) =>
      hasHits
        ? {
            agentStatusByPaneKey: state.agentStatusByPaneKey,
            retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
            sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
            tabsByWorktree: state.tabsByWorktree,
            terminalLayoutsByTabId: state.terminalLayoutsByTabId,
            unifiedTabsByWorktree: state.unifiedTabsByWorktree,
            worktreesByRepo: selectWorktreesByRepo(state),
            folderWorkspaces: selectFolderWorkspaces(state),
            repos: state.repos,
            projectGroups: state.projectGroups,
            detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
            settings: state.settings
          }
        : NO_STORE_INPUTS
    )
  )
  const chatProgramFactsVersion = useChatProgramFactsVersion()
  return useMemo(() => {
    if (hits.length === 0) {
      return null
    }
    // Eligibility reads the store and the host's agent catalog outside its arguments; these track them.
    const inertReasonByHit = recomputeOn(
      [storeInputs, chatProgramFactsVersion, catalogVersion],
      () =>
        new Map(
          hits.map((hit) => {
            const action = resolvePaletteSessionAction(
              readPaletteSessionFacts(useAppStore.getState(), hit)
            )
            return [
              paletteSessionHitId(hit),
              action.kind === 'none' ? action.reason : null
            ] as const
          })
        )
    )
    const inertReasonOf = (hit: (typeof hits)[number]) =>
      inertReasonByHit.get(paletteSessionHitId(hit)) ?? null
    const untitled = t('auto.components.WorktreeJumpPalette.sessionUntitled', 'Untitled session')
    const results = buildSessionPaletteResults(hits, query, {
      untitled,
      onOpen: (hit) => void openPaletteSession(hit, hit.searchHost),
      isInert: (hit) => inertReasonOf(hit) !== null,
      decorate: (hit) => ({
        leading: <PaletteSessionLeading agent={hit.agent} />,
        line: (
          <PaletteSessionLine
            hit={hit}
            hostLabel={hit.searchHost.label}
            title={paletteSessionTitle(hit, untitled)}
            inertReason={inertReasonOf(hit)}
          />
        )
      })
    })
    if (results.length === 0) {
      return null
    }
    return {
      id: SESSION_SOURCE_ID,
      sectionLabel: (translate) =>
        translate('auto.components.WorktreeJumpPalette.sessionsHeader', 'Sessions'),
      emptyQueryCap: 0,
      typedPlacement: 'after-workspaces',
      leadsOnTie: false,
      results
    } satisfies PaletteExtraSource
  }, [catalogVersion, chatProgramFactsVersion, hits, query, storeInputs, t])
}
