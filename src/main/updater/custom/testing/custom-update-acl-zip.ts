import { buildZip, type ZipEntry } from './custom-update-zip-builder'

const EVERYONE = 'ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C:everyone:12'

/**
 * The AppleDouble file (`._name`) that `ditto -c -k --sequesterRsrc` writes next to an entry that carries an access
 * control list, which `ditto -x -k` applies to the entry it names: one extended attribute, `com.apple.acl.text`.
 * Written by hand because `ditto` cannot archive a directory whose ACL denies listing it, and a hostile release can.
 */
export function appleDoubleWithAcl(entry: string): Buffer {
  const name = Buffer.from('com.apple.acl.text\0')
  const value = Buffer.from(`!#acl 1\ngroup:${EVERYONE}:deny:${entry}\n\0`)
  const descriptors = 26 + 2 * 12
  // Finder info is 32 bytes, followed by two bytes of padding before the attribute header.
  const finderInfo = 34
  const attrHeader = 36
  const entryLength = Math.ceil((4 + 4 + 2 + 1 + name.length) / 4) * 4
  const dataStart = descriptors + finderInfo + attrHeader + entryLength
  const total = dataStart + value.length
  const out = Buffer.alloc(total)
  out.writeUInt32BE(0x00051607, 0)
  out.writeUInt32BE(0x00020000, 4)
  out.write('Mac OS X        ', 8, 'latin1')
  out.writeUInt16BE(2, 24)
  // Entry 9 (Finder info and attributes) runs to the end of the file; entry 2 (resource fork) is empty.
  out.writeUInt32BE(9, 26)
  out.writeUInt32BE(descriptors, 30)
  out.writeUInt32BE(total - descriptors, 34)
  out.writeUInt32BE(2, 38)
  out.writeUInt32BE(total, 42)
  out.writeUInt32BE(0, 46)
  const attr = descriptors + finderInfo
  out.write('ATTR', attr, 'latin1')
  out.writeUInt32BE(total, attr + 8)
  out.writeUInt32BE(dataStart, attr + 12)
  out.writeUInt32BE(value.length, attr + 16)
  out.writeUInt16BE(1, attr + 34)
  const first = attr + attrHeader
  out.writeUInt32BE(dataStart, first)
  out.writeUInt32BE(value.length, first + 4)
  out.writeUInt8(name.length, first + 10)
  name.copy(out, first + 11)
  value.copy(out, dataStart)
  return out
}

const dirs = (path: string, mode = 0o755): ZipEntry[] => [{ name: `${path}/`, mode }]

/**
 * A zip with `Orca.app/a/` (holding `b/f`, `g` and, in `b`, one link to each of `links`) whose directory `a`
 * carries the given mode and the ACL entry `deny <acl>`, and whose file `b/f` is one nobody may delete. Everything is
 * restored by the real `ditto -x -k`, which applies the mode and the ACL of `a` only after what is inside it.
 */
export function hostileDirectoryZip(options: {
  mode: number
  acl: string
  links?: string[]
}): Buffer {
  // In `a/b`, below the locked directory: ditto cannot create a link inside a directory that denies delete_child.
  const links = (options.links ?? []).map((target, index): ZipEntry => ({
    name: `Orca.app/a/b/link-${index}`,
    mode: 0o755,
    data: Buffer.from(target),
    symlink: true
  }))
  return buildZip([
    ...dirs('Orca.app'),
    ...dirs('Orca.app/a', options.mode),
    ...dirs('Orca.app/a/b'),
    { name: 'Orca.app/a/b/f', mode: 0o644, data: Buffer.from('x') },
    { name: 'Orca.app/a/g', mode: 0o644, data: Buffer.from('y') },
    ...links,
    ...dirs('__MACOSX', 0o775),
    ...dirs('__MACOSX/Orca.app', 0o775),
    ...dirs('__MACOSX/Orca.app/a', 0o775),
    ...dirs('__MACOSX/Orca.app/a/b', 0o775),
    { name: '__MACOSX/Orca.app/._a', mode: 0o644, data: appleDoubleWithAcl(options.acl) },
    { name: '__MACOSX/Orca.app/a/b/._f', mode: 0o644, data: appleDoubleWithAcl('delete') }
  ])
}
