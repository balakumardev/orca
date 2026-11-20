import { useMemo } from 'react'
import type { Worktree } from '../../../../shared/worktree/types'
import { useBotPaletteSource } from '@/components/bots/bot-palette-source'
import { useBotTemplatePaletteSource } from '@/components/bots/templates/bot-template-palette-source'
import type { PaletteExtraSource } from './palette-extra-results'
import { usePaletteFolderSource } from './use-palette-folder-source'
import { usePaletteProjectCreateSource } from './use-palette-project-create-source'
import { usePaletteSessionSource } from './use-palette-session-source'

/** Each source registers here with its own hook; return a memoized list. */
export function usePaletteExtraSources({
  query,
  visible,
  scoped
}: {
  query: string
  visible: boolean
  /** Showing only bots: template suggestions stay idle. */
  scoped: boolean
}): {
  sources: readonly PaletteExtraSource[]
  /** Workspaces any source lists as itself; stable while the sources' own predicates are. */
  hidesWorkspace: ((worktree: Worktree) => boolean) | null
} {
  const bots = useBotPaletteSource({ query, visible })
  const templates = useBotTemplatePaletteSource({ query, visible: visible && !scoped })
  const projectCreate = usePaletteProjectCreateSource({ query, visible })
  const folders = usePaletteFolderSource({ query, visible })
  const sessions = usePaletteSessionSource({ query, visible })
  const sources = useMemo(
    () =>
      // Bots lead, then their templates; project rows, folders and past conversations follow.
      [bots, templates, projectCreate, folders, sessions].filter(
        (source): source is PaletteExtraSource => source !== null
      ),
    [bots, templates, projectCreate, folders, sessions]
  )
  // Keyed by the predicates, not the results, so a keystroke that only changes bot rows keeps it.
  const botHides = bots?.hidesWorkspace
  const templateHides = templates?.hidesWorkspace
  const hidesWorkspace = useMemo(() => {
    const predicates = [botHides, templateHides].filter(
      (predicate): predicate is (worktree: Worktree) => boolean => predicate !== undefined
    )
    return predicates.length
      ? (worktree: Worktree) => predicates.some((predicate) => predicate(worktree))
      : null
  }, [botHides, templateHides])
  return { sources, hidesWorkspace }
}
