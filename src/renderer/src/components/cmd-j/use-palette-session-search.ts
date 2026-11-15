import { useEffect, useRef, useState } from 'react'
import type { AiVaultSearchHit } from '../../../../shared/ai-vault/search/ai-vault-search-types'
import { resolveAiVaultSearchSettings } from '../../../../shared/ai-vault/search/ai-vault-search-settings'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { useAppStore } from '@/store/index'
import { isSessionIndexReady, sessionSearchQuery } from './palette-session-search-gate'

const SESSION_SEARCH_DEBOUNCE_MS = 150
/** The section shows at most this many rows, so the index is never asked for more. */
export const SESSION_SEARCH_HIT_LIMIT = 6

const NO_HITS: readonly AiVaultSearchHit[] = []

type Answer = { query: string; hits: readonly AiVaultSearchHit[] }

/**
 * Transcript hits for the typed query, from the AI Vault index of this computer. Nothing is called while
 * Agent Session History search is off (the user's choice in Settings), on the web client, or while the first
 * pass over the transcripts is still running. A hit is returned only for the query it answers, so a slow
 * reply for an earlier query can never show under a later one. Failures read as no hits.
 */
export function usePaletteSessionSearch({ query, visible }: { query: string; visible: boolean }): {
  active: boolean
  hits: readonly AiVaultSearchHit[]
} {
  const enabled = useAppStore((state) => resolveAiVaultSearchSettings(state.settings).enabled)
  const active = visible && enabled && !isWebClientLocation()
  const needle = sessionSearchQuery(query)
  const [answer, setAnswer] = useState<Answer | null>(null)
  // The next opening of the palette starts from no hits, even for the same query.
  const [wasActive, setWasActive] = useState(active)
  if (wasActive !== active) {
    setWasActive(active)
    setAnswer(null)
  }
  // Checked again by each query until it is true; one palette opening never asks twice once it is.
  const indexReady = useRef(false)

  useEffect(() => {
    if (!active) {
      indexReady.current = false
      return
    }
    if (needle === null || typeof window.api?.aiVault?.searchSessions !== 'function') {
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        if (!indexReady.current) {
          indexReady.current = isSessionIndexReady(
            await window.api.aiVault.searchStatus(LOCAL_EXECUTION_HOST_ID)
          )
        }
        if (!indexReady.current || cancelled) {
          return
        }
        const response = await window.api.aiVault.searchSessions(
          { query: needle, limit: SESSION_SEARCH_HIT_LIMIT },
          LOCAL_EXECUTION_HOST_ID
        )
        if (!cancelled) {
          setAnswer({ query: needle, hits: response.kind === 'results' ? response.hits : NO_HITS })
        }
        // The rest of the palette works without this section, so a failed call shows nothing and says nothing.
      })().catch(() => {})
    }, SESSION_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [active, needle])

  return { active, hits: active && answer?.query === needle ? answer.hits : NO_HITS }
}
