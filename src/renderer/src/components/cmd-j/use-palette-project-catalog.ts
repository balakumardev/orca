import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import {
  selectPaletteProjectCatalog,
  type PaletteProjectCatalog
} from './palette-project-create-targets'

export function usePaletteProjectCatalog(): PaletteProjectCatalog {
  return useAppStore(useShallow(selectPaletteProjectCatalog))
}
