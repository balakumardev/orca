import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { CommandRunner } from './custom-update-commands'
import { FREE_SPACE_MARGIN_BYTES, freeBytesOf } from './custom-update-disk'
import { CustomUpdateError } from './custom-update-errors'
import {
  isPermissionError,
  measureTree,
  type TreeLimit,
  type TreeMeasure
} from './custom-update-tree'

/** The bundle must sit at the top of the archive under exactly this name (package-release.sh `--keepParent`). */
export const EXPECTED_BUNDLE_NAME = 'Orca.app'
/**
 * Cap on the extracted size, as a multiple of the manifest's zip size, and the entry limit. Measured on a real Orca
 * build packaged the way package-release.sh does: 18,819 entries, 2.59 times its zip. Headroom, not an open door.
 * `custom/scripts/update-size-limits.sh` holds the build-side limits that keep every release under these; a test
 * (custom-update-size-limits-script.test.ts) fails when the two drift apart.
 */
export const EXTRACTED_SIZE_FACTOR = 4
export const MAX_ARCHIVE_ENTRIES = 200_000
// How often the free space is read (one statfs call) and how often the tree is walked. The free-space read is what
// stops a lying archive in time: a walk of a real Orca bundle (9,410 entries) takes about 100 ms, and ditto writes
// more than a gigabyte a second on a fast disk, so the walk alone lets 220 MiB through (measured, see the margin).
const FREE_POLL_INTERVAL_MS = 10
const WALK_INTERVAL_MS = 100
// The zip itself takes whole blocks (4 KiB each), so a little less is free when extraction starts than when the
// download did; the slack keeps a release that was allowed to download from being refused at the very next step.
const DISK_START_SLACK_BYTES = 1024 * 1024

/**
 * What the disk must hold before a download is worth starting: the zip, the extracted copy at the most the size
 * rule allows, the margin the extraction keeps free, and the slack. The download and the update cycle both ask this
 * one function, and the extraction asks for what is left of it once the zip is on the disk.
 */
export const diskNeededFor = (zipBytes: number): number =>
  zipBytes * (1 + EXTRACTED_SIZE_FACTOR) + FREE_SPACE_MARGIN_BYTES + DISK_START_SLACK_BYTES

function refuse(detail: string): never {
  throw new CustomUpdateError('verification', `Update check "extract-size" failed: ${detail}`)
}

function outOfDisk(freeBytes: number, zipBytes: number): CustomUpdateError {
  return new CustomUpdateError('disk-space', 'There is not enough free disk space for the update', {
    freeBytes,
    neededBytes: diskNeededFor(zipBytes)
  })
}

export type ExtractRequest = {
  zipPath: string
  destination: string
  /** The size the manifest promised for the zip; the extracted copy is capped relative to it. */
  zipBytes: number
  run: CommandRunner
  getFreeBytes?: (directory: string) => Promise<number>
  measure?: (directory: string, limit: TreeLimit) => Promise<TreeMeasure>
  /** How often the tree is walked; the free space is read more often than that. */
  monitorIntervalMs?: number
  freePollIntervalMs?: number
  /** Free space that must stay free while the archive is extracted (tests use a small one). */
  marginBytes?: number
}

/**
 * Looks at what the archive claims it holds before anything is written. The central directory can lie, so the
 * extraction itself is watched as well: the copy on disk may never pass the cap.
 */
async function assertArchiveWithinBudget(request: ExtractRequest, sizeCap: number): Promise<void> {
  const listing = await request.run('/usr/bin/zipinfo', ['-t', request.zipPath])
  const totals = /^(\d+) files?, (\d+) bytes uncompressed/m.exec(listing.stdout)
  if (listing.code !== 0 || !totals) {
    refuse('the archive could not be inspected')
  }
  const entries = Number(totals[1])
  const uncompressed = Number(totals[2])
  if (entries > MAX_ARCHIVE_ENTRIES) {
    refuse(`the archive holds ${entries} entries`)
  }
  if (uncompressed > sizeCap) {
    refuse('the archive expands to more than the allowed size')
  }
}

// `unmeasurable`: the tree could not be read for a reason that says nothing about the archive (EMFILE, EIO).
type Verdict = {
  reason: 'size' | 'unreadable' | 'unmeasurable' | 'disk' | null
  freeBytes: number
}

/**
 * Extracts with two watchers on the result. The cap is a multiple of the zip's size, and the disk must hold the cap
 * plus a margin before anything starts. While `ditto` runs, one `statfs` every few milliseconds stops it as soon as
 * the free space falls below the margin. A drop of more than the cap is only suspicious: it is every writer on the
 * machine, not this archive alone, so it is confirmed by a walk of our own tree before it stops anything. A slower
 * walk of the tree measures what is really on disk. A tree that cannot be listed because of its modes (what an
 * archive can make) is refused like one that is too big; one that cannot be read for any other reason (EMFILE, EIO) is
 * not a verdict on the archive. The watchers only read, and the verifier restores access only when it deletes the tree.
 */
export async function extractArchive(request: ExtractRequest): Promise<void> {
  const sizeCap = request.zipBytes * EXTRACTED_SIZE_FACTOR
  const margin = request.marginBytes ?? FREE_SPACE_MARGIN_BYTES
  const readFree = request.getFreeBytes ?? freeBytesOf
  const freeAtStart = await readFree(request.destination)
  if (freeAtStart < sizeCap + margin) {
    throw outOfDisk(freeAtStart, request.zipBytes)
  }
  await assertArchiveWithinBudget(request, sizeCap)

  const limit: TreeLimit = { maxBytes: sizeCap, maxEntries: MAX_ARCHIVE_ENTRIES }
  const measure = request.measure ?? measureTree
  const stop = new AbortController()
  // Held in an object: the watchers set it from callbacks that TypeScript's flow analysis does not follow.
  const verdict: Verdict = { reason: null, freeBytes: freeAtStart }
  const trip = (reason: NonNullable<Verdict['reason']>, freeBytes = verdict.freeBytes): void => {
    verdict.reason ??= reason
    verdict.freeBytes = freeBytes
    stop.abort()
  }
  // One walk at a time, whoever asks: a bundle with tens of thousands of files can take longer than the interval,
  // and the confirmation of a drop in free space joins the walk that is already under way.
  let inFlight: Promise<TreeMeasure> | null = null
  const walk = (): Promise<TreeMeasure> => {
    inFlight ??= measure(request.destination, limit).finally(() => {
      inFlight = null
    })
    return inFlight
  }
  let reading: Promise<void> | null = null
  const poller = setInterval(() => {
    if (reading) {
      return
    }
    reading = readFree(request.destination)
      .then(async (free) => {
        if (free < margin) {
          trip('disk', free)
        } else if (freeAtStart - free > sizeCap && (await walk()).exceeded) {
          trip('size')
        }
      })
      // A failed read says nothing about the disk, and a failed confirmation walk is the regular walk's to report.
      .catch(() => undefined)
      .finally(() => {
        reading = null
      })
  }, request.freePollIntervalMs ?? FREE_POLL_INTERVAL_MS)
  let walking: Promise<void> | null = null
  const walker = setInterval(() => {
    if (walking) {
      return
    }
    walking = walk()
      .then((measured) => {
        if (measured.exceeded) {
          trip('size')
        }
      })
      // A tree that cannot be read is not an empty one.
      .catch((error: unknown) => trip(isPermissionError(error) ? 'unreadable' : 'unmeasurable'))
      .finally(() => {
        walking = null
      })
  }, request.monitorIntervalMs ?? WALK_INTERVAL_MS)
  const stopWatching = (): void => {
    clearInterval(poller)
    clearInterval(walker)
  }
  try {
    const result = await request.run(
      '/usr/bin/ditto',
      ['-x', '-k', request.zipPath, request.destination],
      { signal: stop.signal }
    )
    // The last look waits for a read and a walk still in flight rather than running beside them.
    stopWatching()
    await Promise.all([reading, walking])
    let finalError: unknown = null
    const final = await measure(request.destination, limit).catch((error: unknown) => {
      finalError = error
      return null
    })
    // What is on disk decides: a tree past the cap is the archive's doing whatever else the disk was doing.
    if (verdict.reason === 'size' || final?.exceeded) {
      refuse('the archive expanded past the allowed size while it was extracted')
    }
    if (verdict.reason === 'unreadable' || (!final && isPermissionError(finalError))) {
      refuse('the extracted files could not be measured')
    }
    if (verdict.reason === 'disk') {
      throw outOfDisk(verdict.freeBytes, request.zipBytes)
    }
    if (verdict.reason === 'unmeasurable' || !final) {
      throw new CustomUpdateError('check-error', 'The extracted update could not be measured', {
        cause: finalError
      })
    }
    if (result.code !== 0) {
      await failExtraction(readFree, request.destination, margin, request.zipBytes)
    }
  } finally {
    stopWatching()
  }
}

/**
 * A `ditto` that stopped on its own. Whether the disk ran out is decided by the free space, read now, and never by
 * what `ditto` printed: that text can carry a file name from the archive. With room left the cause is unknown (the
 * archive may be malformed, or the machine may have failed it), so it is a retryable `check-error`; a release that
 * keeps failing this way is set aside by the strike count, not by this one failure.
 */
async function failExtraction(
  readFree: (directory: string) => Promise<number>,
  destination: string,
  margin: number,
  zipBytes: number
): Promise<never> {
  const free = await readFree(destination).catch(() => Number.POSITIVE_INFINITY)
  if (free < margin) {
    throw outOfDisk(free, zipBytes)
  }
  throw new CustomUpdateError('check-error', 'Update check "extract" failed: not extractable')
}

/** The one bundle in the extracted tree: right name, a real directory, and inside the extraction directory. */
export async function findExtractedBundle(extractDir: string): Promise<string> {
  const entries = await readdir(extractDir)
  if (entries.length !== 1 || entries[0] !== EXPECTED_BUNDLE_NAME) {
    throw new CustomUpdateError(
      'verification',
      `Update check "archive-layout" failed: the archive must hold exactly ${EXPECTED_BUNDLE_NAME}`
    )
  }
  const bundle = join(extractDir, EXPECTED_BUNDLE_NAME)
  const stats = await lstat(bundle)
  const inside = (await realpath(bundle)).startsWith(`${await realpath(extractDir)}${sep}`)
  if (!stats.isDirectory() || stats.isSymbolicLink() || !inside) {
    throw new CustomUpdateError(
      'verification',
      'Update check "archive-layout" failed: the bundle is not a plain directory'
    )
  }
  return bundle
}
