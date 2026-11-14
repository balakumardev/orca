import { statfs } from 'node:fs/promises'

/**
 * Free space that must stay free while an archive is extracted. macOS stages its own copy of the update right
 * after, and the watcher in `custom-update-extract.ts` cannot stop `ditto` the moment the cap is passed: with the
 * cap at 2.5 MiB it had written 14 to 27 MiB on an idle Mac and 11 to 170 MiB while the whole test suite ran beside
 * it (measured, custom-update-hostile-disk.darwin.test.ts). The margin is what keeps a lying archive, and a busy
 * machine, from filling the disk: it is several times the worst overshoot seen.
 */
export const FREE_SPACE_MARGIN_BYTES = 1024 ** 3

export async function freeBytesOf(directory: string): Promise<number> {
  const stats = await statfs(directory)
  return stats.bavail * stats.bsize
}
