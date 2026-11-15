import type React from 'react'
import { GitBranchPlus } from 'lucide-react'

export function PaletteProjectCreateLeading(): React.JSX.Element {
  return (
    <span className="flex h-5 w-4 items-center justify-center text-muted-foreground/85">
      <GitBranchPlus className="size-3.5" aria-hidden="true" />
    </span>
  )
}
