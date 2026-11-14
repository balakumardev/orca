import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import type { CustomUpdateFailureKind } from './custom-update-errors'
import { parseCustomBuildVersion } from './custom-update-version'

export const UPDATE_STATE_FILE_NAME = 'custom-update-state.json'
/** How long a verdict on a release holds. A release that is still bad then costs one more download, no more. */
export const UPDATE_STATE_TTL_MS = 30 * 24 * 60 * 60_000
/**
 * A failure that proves nothing alone counts towards setting a release aside for this long, and no longer; a release
 * that was set aside is held for this long too, so it is tried again after it.
 */
export const STRIKE_WINDOW_MS = 24 * 60 * 60_000
// Two clocks (or one that was corrected) can disagree by hours; a record dated further ahead than this is not ours.
const CLOCK_SKEW_MS = 24 * 60 * 60_000
const MAX_RECORDS = 64
// 64 records are about 8 KB; a file far past that is not ours and is not read.
const MAX_FILE_BYTES = 64 * 1024
const FORMAT_VERSION = 2
// Only a verdict about the release's own bytes is written to disk. Everything else (a tool that could not run, a
// timeout, macOS refusing to stage, a checksum that missed once) says something about this machine at this moment.
const PERSISTED_KINDS: ReadonlySet<string> = new Set<CustomUpdateFailureKind>(['verification'])

/** Which side of the update a strike came from: the checks after the download, or macOS staging it. */
export type StrikeStage = 'check' | 'staging'

/** A release set aside for good: its manifest version, the sha256 of the zip that was judged, and why. */
type StateRecord = {
  version: string
  sha256: string
  /** When the verdict was made; the time to live counts from here. */
  at: number
  kind: string
}

const keyOf = (version: string, sha256: string): string => `${version}\n${sha256}`

/** Keeps only the records that are well formed; anything else in the file is dropped, not trusted. */
function parseRecords(text: string): StateRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== FORMAT_VERSION ||
    !('records' in parsed) ||
    !Array.isArray(parsed.records)
  ) {
    return []
  }
  const records: StateRecord[] = []
  for (const raw of parsed.records.slice(0, MAX_RECORDS * 2)) {
    if (typeof raw !== 'object' || raw === null) {
      continue
    }
    const { version, sha256, at, kind } = raw as Record<string, unknown>
    if (
      typeof version === 'string' &&
      parseCustomBuildVersion(version) !== null &&
      typeof sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(sha256) &&
      typeof at === 'number' &&
      Number.isSafeInteger(at) &&
      at >= 0 &&
      typeof kind === 'string' &&
      PERSISTED_KINDS.has(kind)
    ) {
      records.push({ version, sha256, at, kind })
    }
  }
  return records
}

/**
 * Read at most MAX_FILE_BYTES + 1 bytes, so a file that is far too large is noticed without being read whole. Only a
 * plain file is read: opening a FIFO would wait for a writer (and load() runs while the app starts), a device has no
 * end, and a link can lead anywhere. The open does not block and does not follow a link, and the handle is checked
 * again, so a path that is swapped between the check and the open is caught too.
 */
function readBounded(file: string): string | null {
  if (!lstatSync(file).isFile()) {
    return null
  }
  const handle = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    if (!fstatSync(handle).isFile()) {
      return null
    }
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    const bytesRead = readSync(handle, buffer, 0, buffer.length, 0)
    return bytesRead > MAX_FILE_BYTES ? null : buffer.toString('utf8', 0, bytesRead)
  } finally {
    closeSync(handle)
  }
}

let writeCounter = 0

/** Write beside the file and rename over it, so a crash leaves the old file or the new one, never half of one. */
async function writeAtomically(file: string, text: string): Promise<void> {
  writeCounter += 1
  const temporary = `${file}.${process.pid}.${writeCounter}.tmp`
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * What the updater has learned about releases. Verdicts about a release's own bytes (a signature that does not
 * hold, a bundle that is not ours) are kept in the user data directory for 30 days, so a restart, or a person asking
 * for another check, does not download that release again. Nothing else is written down: strikes (failures that
 * prove nothing alone) and a release set aside because it collected three of them live in memory, both only for a
 * day, so a transient fault on this machine cannot become a lasting verdict on a release.
 *
 * Time never deletes a record from the file: it only decides whether one is honoured, so a clock that is wrong for
 * a while cannot erase what the file holds. Records are dropped when there are more than 64 (the oldest first), and
 * at load when they are dated more than a day ahead. Reading never throws (a missing, oversized or corrupt file is an
 * empty state) and a failed write only costs the memory of the next run.
 */
export class CustomUpdateState {
  private readonly records = new Map<string, StateRecord>()
  private readonly strikes = new Map<string, { at: number; stage: StrikeStage }[]>()
  /** When each release was set aside; it is honoured for STRIKE_WINDOW_MS from then. */
  private readonly setAside = new Map<string, number>()
  private writing: Promise<void> = Promise.resolve()

  /** `file` null keeps the state in memory only. */
  constructor(
    private readonly file: string | null,
    private readonly now: () => number,
    private readonly onWriteFailed: () => void = () => undefined
  ) {}

  /**
   * Reads the file once, at start. It is synchronous on purpose: the file is at most 64 KiB and read once, and the first
   * check, which comes a minute and a half later, must never have to wait for it.
   */
  load(): void {
    if (!this.file) {
      return
    }
    try {
      const text = readBounded(this.file)
      for (const record of text === null ? [] : parseRecords(text)) {
        if (record.at - this.now() <= CLOCK_SKEW_MS) {
          this.records.set(keyOf(record.version, record.sha256), record)
        }
      }
    } catch {
      // No file yet, or one that cannot be read: start empty.
    }
    this.limit()
  }

  /** Resolves once every queued write has finished. */
  flush(): Promise<void> {
    return this.writing
  }

  /**
   * True for a release judged bad for good, and, unless `includeTemporary` is false, for one set aside after three
   * strikes during the last day. A person asking for a check passes false: they should not be told they are up to
   * date because of what this machine did a few hours ago.
   */
  isRejected(version: string, sha256: string, includeTemporary = true): boolean {
    const key = keyOf(version, sha256)
    const record = this.records.get(key)
    const age = record ? this.now() - record.at : Number.NaN
    const live = age < UPDATE_STATE_TTL_MS && age > -CLOCK_SKEW_MS
    return live || (includeTemporary && this.isSetAside(key))
  }

  /** A time dated ahead of the clock cannot be aged, so it is not honoured, as with a strike. */
  private isSetAside(key: string): boolean {
    const at = this.setAside.get(key)
    const age = at === undefined ? Number.NaN : this.now() - at
    return age >= 0 && age < STRIKE_WINDOW_MS
  }

  /** Writes a verdict about the release's own bytes. Any other kind of failure is only set aside, in memory. */
  reject(version: string, sha256: string, kind: CustomUpdateFailureKind): void {
    if (!PERSISTED_KINDS.has(kind)) {
      this.setAsideForNow(version, sha256)
      return
    }
    this.records.set(keyOf(version, sha256), { version, sha256, at: this.now(), kind })
    this.limit()
    this.save()
  }

  /**
   * Counts one more failure that proves nothing alone; returns how many of this stage there are in the last day now.
   * The limit is for failing the same way, so a staging failure and two check timeouts are not three of a kind.
   */
  addStrike(version: string, sha256: string, stage: StrikeStage): number {
    const key = keyOf(version, sha256)
    const now = this.now()
    // A strike dated ahead of the clock cannot be aged, so it does not count.
    const recent = (this.strikes.get(key) ?? []).filter(
      (strike) => now - strike.at >= 0 && now - strike.at < STRIKE_WINDOW_MS
    )
    recent.push({ at: now, stage })
    this.strikes.delete(key)
    this.strikes.set(key, recent)
    this.forgetOldestInMemory()
    return recent.filter((strike) => strike.stage === stage).length
  }

  /** A clean pass of one stage (the checks held) ends that stage's strikes; the other stage's are not touched. */
  resetStrikes(version: string, sha256: string, stage: StrikeStage): void {
    const key = keyOf(version, sha256)
    const remaining = (this.strikes.get(key) ?? []).filter((strike) => strike.stage !== stage)
    if (remaining.length > 0) {
      this.strikes.set(key, remaining)
    } else {
      this.strikes.delete(key)
    }
  }

  /**
   * Skips the release for a day (or until a person asks for a check, or the app restarts); nothing is written. After
   * the day the release is tried again, so a fault of this machine that has passed does not hold back a good release.
   */
  setAsideForNow(version: string, sha256: string): void {
    const key = keyOf(version, sha256)
    // Re-inserted, so that the map stays ordered by time and the oldest entries are the first to go.
    this.setAside.delete(key)
    this.setAside.set(key, this.now())
    this.forgetOldestInMemory()
  }

  /** The release was staged: what was held against it no longer matters. */
  clear(version: string, sha256: string): void {
    const key = keyOf(version, sha256)
    this.strikes.delete(key)
    this.setAside.delete(key)
    if (this.records.delete(key)) {
      this.save()
    }
  }

  private forgetOldestInMemory(): void {
    for (const [key, at] of this.setAside) {
      // Only what has aged out is dropped: one dated ahead of the clock may count again when the clock is right.
      if (this.now() - at >= STRIKE_WINDOW_MS) {
        this.setAside.delete(key)
      }
    }
    for (const collection of [this.strikes, this.setAside]) {
      while (collection.size > MAX_RECORDS) {
        const oldest = collection.keys().next()
        if (oldest.done) {
          break
        }
        collection.delete(oldest.value)
      }
    }
  }

  private limit(): void {
    const oldestFirst = [...this.records].sort((a, b) => a[1].at - b[1].at)
    for (const [key] of oldestFirst.slice(0, Math.max(0, oldestFirst.length - MAX_RECORDS))) {
      this.records.delete(key)
    }
  }

  private save(): void {
    const { file } = this
    if (!file) {
      return
    }
    const text = JSON.stringify({ version: FORMAT_VERSION, records: [...this.records.values()] })
    this.writing = this.writing
      .then(() => writeAtomically(file, text))
      .catch(() => this.onWriteFailed())
  }
}
