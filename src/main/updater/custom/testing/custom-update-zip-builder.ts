import { crc32, deflateRawSync } from 'node:zlib'

const UNIX = 3
const DIRECTORY = 0o040000
const FILE = 0o100000
const LINK = 0o120000

export type ZipEntry = {
  name: string
  /** Unix permission bits, e.g. 0o111 for a directory nobody may read. */
  mode: number
  /** A directory has no data. */
  data?: Buffer
  /** A symbolic link: `data` is the path it points at. */
  symlink?: boolean
  /** What the central directory claims the entry expands to, whatever it really does. */
  claimedSize?: number
}

/**
 * A zip written by hand so a test can lie in it the way a hostile release can: the central directory (what
 * `zipinfo` reads) states one size, the compressed stream (what `ditto` writes out) holds another.
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const isDirectory = entry.name.endsWith('/')
    const name = Buffer.from(entry.name)
    const raw = entry.data ?? Buffer.alloc(0)
    // A link's target is stored as it is, which is how `ditto -c -k` writes one and what `ditto -x -k` expects.
    const packed = isDirectory ? Buffer.alloc(0) : entry.symlink ? raw : deflateRawSync(raw)
    const crc = isDirectory ? 0 : crc32(raw)
    const method = isDirectory || entry.symlink ? 0 : 8
    const claimed = entry.claimedSize ?? raw.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(claimed, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, packed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((UNIX << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(claimed, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(
      ((isDirectory ? DIRECTORY : entry.symlink ? LINK : FILE) | entry.mode) * 0x10000,
      38
    )
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + packed.length
  }
  const centralBytes = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}
