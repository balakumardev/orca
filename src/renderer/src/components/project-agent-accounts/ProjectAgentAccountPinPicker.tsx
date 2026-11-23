import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { searchRepos } from '@/lib/workspace/catalog/repo-search'
import type { Repo } from '../../../../shared/repository/repo-types'
import RepoBadgeLabel from '../repo/RepoBadgeLabel'
import { Button } from '../ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/** Searchable list of this computer's projects that have no pin yet. */
export function ProjectAgentAccountPinPicker({
  repos,
  onPick
}: {
  repos: readonly Repo[]
  onPick: (repo: Repo) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const matches = useMemo(() => searchRepos(repos, query), [repos, query])
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={repos.length === 0}
          className="shrink-0"
        >
          <Plus className="size-3" />
          {t('projectAgentAccounts.pinProject', 'Pin a project…')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(320px,calc(100vw-1rem))]">
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            placeholder={t('projectAgentAccounts.searchProjects', 'Search projects…')}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>
              {t('projectAgentAccounts.noProjectMatches', 'No projects match your search.')}
            </CommandEmpty>
            {matches.map((repo) => (
              <CommandItem
                key={repo.id}
                value={repo.id}
                onSelect={() => {
                  setOpen(false)
                  setQuery('')
                  onPick(repo)
                }}
                className="flex-col items-start"
              >
                <RepoBadgeLabel name={repo.displayName} color={repo.badgeColor} />
                <span className="w-full truncate text-2xs text-muted-foreground">{repo.path}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
