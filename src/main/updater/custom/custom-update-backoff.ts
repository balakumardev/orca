/** How long to leave a release alone after its first failed download, in the background. */
export const DOWNLOAD_RETRY_INITIAL_MS = 15 * 60_000
export const DOWNLOAD_RETRY_MAX_MS = 6 * 60 * 60_000

/**
 * A download that stalls, is cut, or ends short costs the whole zip again, and a link that keeps doing it would
 * cost a few hundred megabytes every few minutes. This is the wait before the next scheduled try of the same
 * release: 15 minutes, doubled for each failure in a row, never more than 6 hours. It lives in memory (a restart
 * starts again), follows one release (a newer one starts from the beginning), and ends when the release is
 * staged. A person asking for a check is never made to wait for it, but that try counts too.
 */
export class DownloadBackoff {
  private version: string | null = null
  private failures = 0

  /** A download of `version` failed: how long the next scheduled try waits. */
  failed(version: string): number {
    if (this.version !== version) {
      this.version = version
      this.failures = 0
    }
    this.failures += 1
    return Math.min(DOWNLOAD_RETRY_INITIAL_MS * 2 ** (this.failures - 1), DOWNLOAD_RETRY_MAX_MS)
  }

  reset(): void {
    this.version = null
    this.failures = 0
  }
}
