import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiVaultSearchHit } from '../../../../shared/ai-vault/search/ai-vault-search-types'
import { resolveAiVaultSearchSettings } from '../../../../shared/ai-vault/search/ai-vault-search-settings'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { AI_VAULT_RUNTIME_CAPABILITY } from '../../../../shared/ai-vault/contracts/ai-vault-runtime-capabilities'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { useAppStore } from '@/store/index'
import { isSessionIndexReady, sessionSearchQuery } from './palette-session-search-gate'
import { isPaletteSearchHostCurrent, type PaletteSearchHost } from './palette-search-hosts'
import { usePaletteSearchHosts } from './use-palette-search-hosts'
import { paletteSessionSearchScopes } from './palette-session-search-scopes'
import { paletteSessionHitId } from './palette-session-results'

const SESSION_SEARCH_DEBOUNCE_MS = 150
/** The section shows at most this many rows, so the index is never asked for more. */
export const SESSION_SEARCH_HIT_LIMIT = 6

export type PaletteSessionSearchHit = AiVaultSearchHit & { searchHost: PaletteSearchHost }
const NO_HITS: readonly PaletteSessionSearchHit[] = []

type Answer = { key: string; legs: ReadonlyMap<string, readonly PaletteSessionSearchHit[]> }

/**
 * Each connected host owns its consent and readiness; independent replies keep local results responsive.
 */
export function usePaletteSessionSearch({
  query,
  visible,
  hostIds,
  repoIds
}: {
  query: string
  visible: boolean
  hostIds?: readonly string[]
  repoIds?: readonly string[]
}): {
  active: boolean
  hits: readonly PaletteSessionSearchHit[]
} {
  const enabled = useAppStore((state) => resolveAiVaultSearchSettings(state.settings).enabled)
  const repos = useAppStore((state) => state.repos)
  const hosts = usePaletteSearchHosts(hostIds)
  const repoSelection = JSON.stringify([...new Set(repoIds ?? [])].sort())
  const sources = useMemo(() => {
    const selectedRepoIds: string[] = JSON.parse(repoSelection)
    return hosts.flatMap((host) => {
      if (
        host.executionHostId === LOCAL_EXECUTION_HOST_ID
          ? !enabled
          : !host.capabilities.includes(AI_VAULT_RUNTIME_CAPABILITY)
      ) {
        return []
      }
      const scopes = paletteSessionSearchScopes(host, repos, selectedRepoIds)
      return scopes.length ? [{ host, scopes }] : []
    })
  }, [enabled, hosts, repos, repoSelection])
  const active = visible && sources.length > 0 && !isWebClientLocation()
  const needle = sessionSearchQuery(query)
  const key = JSON.stringify([needle, sources.map(({ host, scopes }) => [host.key, scopes])])
  const [answer, setAnswer] = useState<Answer | null>(null)
  // Forgotten with the query: shown again for a query typed back, its rows mount as the highlight resets
  // and cmdk selects none. The next opening of the palette starts from no hits too, even for the same query.
  const [asked, setAsked] = useState({ active, needle })
  if (asked.active !== active || asked.needle !== needle) {
    setAsked({ active, needle })
    setAnswer(null)
  }
  // Checked again by each query until it is true; one palette opening never asks twice once it is.
  const indexReady = useRef(new Set<string>())

  useEffect(() => {
    if (!active) {
      indexReady.current.clear()
      return
    }
    if (needle === null || typeof window.api?.aiVault?.searchSessions !== 'function') {
      return
    }
    let cancelled = false
    const publish = (leg: string, hits: readonly PaletteSessionSearchHit[]): void => {
      setAnswer((previous) => ({
        key,
        legs: new Map(previous?.key === key ? previous.legs : []).set(leg, hits)
      }))
    }
    const timer = setTimeout(() => {
      for (const { host, scopes } of sources) {
        const current = () => !cancelled && isPaletteSearchHostCurrent(host)
        void (async () => {
          if (!current()) {
            return
          }
          if (!indexReady.current.has(host.key)) {
            const ready = isSessionIndexReady(
              await window.api.aiVault.searchStatus(host.executionHostId)
            )
            if (!ready || !current()) {
              return
            }
            indexReady.current.add(host.key)
          }
          for (const [index, within] of scopes.entries()) {
            if (!current()) {
              return
            }
            const leg = `${host.key}:${index}`
            void window.api.aiVault
              .searchSessions(
                { query: needle, limit: SESSION_SEARCH_HIT_LIMIT, ...(within ? { within } : {}) },
                host.executionHostId
              )
              .then((response) => {
                if (!current()) {
                  return
                }
                // Scope transport owns attribution; a host cannot redirect a result to another machine.
                publish(
                  leg,
                  response.kind === 'results'
                    ? response.hits.map((hit) => ({
                        ...hit,
                        executionHostId: host.executionHostId,
                        searchHost: host
                      }))
                    : NO_HITS
                )
              })
              .catch(() => {
                if (current()) {
                  publish(leg, NO_HITS)
                }
              })
          }
        })().catch(() => {})
      }
    }, SESSION_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [active, needle, key, sources])

  const hits = useMemo(() => {
    if (!active || answer?.key !== key) {
      return NO_HITS
    }
    const seen = new Set<string>()
    // Host order keeps the local baseline first, regardless of response order.
    return sources
      .flatMap(({ host, scopes }) =>
        scopes.flatMap((_, index) => answer.legs.get(`${host.key}:${index}`) ?? NO_HITS)
      )
      .filter((hit) => {
        const id = paletteSessionHitId(hit)
        if (seen.has(id) || !isPaletteSearchHostCurrent(hit.searchHost)) {
          return false
        }
        seen.add(id)
        return true
      })
      .slice(0, SESSION_SEARCH_HIT_LIMIT)
  }, [active, answer, key, sources])
  return { active, hits }
}
