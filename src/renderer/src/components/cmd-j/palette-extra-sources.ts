import { useMemo } from 'react'
import type { PaletteExtraSource } from './palette-extra-results'
import { usePaletteFolderSource } from './use-palette-folder-source'
import { usePaletteProjectCreateSource } from './use-palette-project-create-source'
import { usePaletteSessionSource } from './use-palette-session-source'

const NO_SOURCES: readonly PaletteExtraSource[] = []

/** Each source registers here with its own hook; return a memoized list. */
export function usePaletteExtraSources(args: {
  query: string
  visible: boolean
  hostIds?: readonly string[]
  repoIds?: readonly string[]
}): readonly PaletteExtraSource[] {
  const projectCreate = usePaletteProjectCreateSource({
    ...args,
    visible: args.visible && !args.hostIds?.length && !args.repoIds?.length
  })
  const folders = usePaletteFolderSource(args)
  const sessions = usePaletteSessionSource(args)
  return useMemo(() => {
    // Project rows first, then folders, then past conversations.
    const sources = [projectCreate, folders, sessions].filter((source) => source !== null)
    return sources.length > 0 ? sources : NO_SOURCES
  }, [projectCreate, folders, sessions])
}
