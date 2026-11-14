export type CustomUpdateFailureKind =
  | 'network'
  | 'rate-limited'
  | 'feed'
  | 'download'
  | 'disk-space'
  | 'verification'
  | 'staging'
  | 'staging-timeout'
  | 'check-timeout'
  | 'check-error'

export class CustomUpdateError extends Error {
  readonly kind: CustomUpdateFailureKind
  readonly retryAfterMs: number | null
  /** The HTTP status that caused it, when there was one. */
  readonly status: number | null
  /** Free bytes on the disk when a `disk-space` failure happened (read from the file system, never from a tool's text). */
  readonly freeBytes: number | null
  /** The free space the update needs, when a `disk-space` failure knows it: the card says how much to make room for. */
  readonly neededBytes: number | null

  constructor(
    kind: CustomUpdateFailureKind,
    message: string,
    options: {
      retryAfterMs?: number
      status?: number
      freeBytes?: number
      neededBytes?: number
      cause?: unknown
    } = {}
  ) {
    super(message, { cause: options.cause })
    this.name = 'CustomUpdateError'
    this.kind = kind
    this.retryAfterMs = options.retryAfterMs ?? null
    this.status = options.status ?? null
    this.freeBytes = options.freeBytes ?? null
    this.neededBytes = options.neededBytes ?? null
  }

  /** A rejected bundle fails the same way every time; everything else may clear on a later try. */
  get retryable(): boolean {
    return this.kind !== 'verification'
  }
}

export function toCustomUpdateError(
  error: unknown,
  fallbackKind: CustomUpdateFailureKind
): CustomUpdateError {
  if (error instanceof CustomUpdateError) {
    return error
  }
  return new CustomUpdateError(
    fallbackKind,
    error instanceof Error ? error.message : String(error),
    {
      cause: error
    }
  )
}

/**
 * What may go into a crash breadcrumb. Our own messages are fixed text; a wrapped foreign error can carry
 * anything (host names, file paths), so only its type is kept.
 */
export function describeFailureForLog(error: unknown): { errorType: string; message?: string } {
  if (error instanceof CustomUpdateError && error.cause === undefined) {
    return { errorType: error.kind, message: error.message }
  }
  const origin = error instanceof CustomUpdateError ? error.cause : error
  return { errorType: origin instanceof Error ? origin.name : typeof origin }
}
