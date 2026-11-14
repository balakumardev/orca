import { useMemo } from 'react'
import type { PaletteExtraSource } from './palette-extra-results'
import { usePaletteFolderSource } from './use-palette-folder-source'

const NO_SOURCES: readonly PaletteExtraSource[] = []

/** Each source registers here with its own hook; return a memoized list. */
export function usePaletteExtraSources(args: {
  query: string
  visible: boolean
}): readonly PaletteExtraSource[] {
  const folders = usePaletteFolderSource(args)
  return useMemo(() => (folders ? [folders] : NO_SOURCES), [folders])
}
