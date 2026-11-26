let hold: symbol | null = null

/** Fence nonpersistent starts across asynchronous window close, until quit succeeds or is vetoed. */
export function holdSourceUpdateSessionStarts(): () => void {
  const owner = Symbol('source-update')
  hold = owner
  return () => {
    if (hold === owner) {
      hold = null
    }
  }
}

/** Called before a start reserves its process; ordinary launches never hold this gate. */
export function assertSourceUpdateSessionStartAllowed(): void {
  if (hold) {
    throw new Error('Orca is restarting for a source update; retry after it reopens.')
  }
}
