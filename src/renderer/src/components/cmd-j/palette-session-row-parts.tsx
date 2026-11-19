import type React from 'react'
import type { AiVaultSearchHit } from '../../../../shared/ai-vault/search/ai-vault-search-types'
import { agentLabel } from '../../../../shared/ai-vault/session-display/ai-vault-session-filters'
import { getRuntimePathBasename } from '../../../../shared/file-access/cross-platform-path'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { highlightedSearchSnippet } from '@/components/right-sidebar/ai-vault/search/AiVaultSearchEvidence'
import { useTranslate } from '@/i18n/use-translate'
import type { PaletteSessionInertReason } from './palette-session-action'
import { paletteSessionSnippetAddsInfo } from './palette-session-snippet'

export function PaletteSessionLeading({ agent }: { agent: AiVaultSearchHit['agent'] }) {
  return (
    <span
      data-palette-session-agent={agent}
      className="flex h-5 w-4 items-center justify-center text-muted-foreground/85"
    >
      <AgentIcon agent={agent} size={14} />
    </span>
  )
}

/** Agent, folder and branch on one line, then the transcript excerpt with the matched words. */
export function PaletteSessionLine({
  hit,
  title,
  inertReason
}: {
  hit: AiVaultSearchHit
  title: string
  inertReason: PaletteSessionInertReason | null
}): React.JSX.Element {
  const t = useTranslate()
  const folder = hit.cwd ? getRuntimePathBasename(hit.cwd) : ''
  const hint =
    inertReason === 'folder-not-in-orca'
      ? t('auto.components.WorktreeJumpPalette.sessionFolderNotInOrca', 'folder not in Orca')
      : inertReason === 'cannot-resume'
        ? t('auto.components.WorktreeJumpPalette.sessionCannotResume', 'cannot be resumed here')
        : ''
  // The hint comes before the folder name: a long name is cut at the end of the line and would hide it.
  const where = [agentLabel(hit.agent), hint, folder, hit.branch ?? ''].filter(Boolean).join(' · ')
  return (
    <>
      <span
        className="block truncate"
        data-palette-session-where=""
        data-palette-session-inert={inertReason ?? undefined}
      >
        {where}
      </span>
      {hit.evidence && paletteSessionSnippetAddsInfo(hit.evidence.snippet, title) ? (
        // The match shows in the palette's own emphasis, not the sidebar's highlighter box. A narrow window
        // shows the title only: the excerpt is unredacted transcript text.
        <span
          className="block truncate text-muted-foreground/75 max-sm:hidden [&_mark]:bg-transparent [&_mark]:px-0 [&_mark]:font-semibold [&_mark]:text-foreground"
          data-palette-session-snippet=""
        >
          {highlightedSearchSnippet(hit.evidence.snippet)}
        </span>
      ) : null}
    </>
  )
}
