import { dirname, join } from 'node:path'

type FakeCall = { fn: 'readdir' | 'lstat' | 'realpath' | 'open'; path: string }

const neverSettles = (): Promise<never> => new Promise(() => {})

function missing(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), {
    code: 'ENOENT'
  })
}

type FakeFs = {
  dirs: Map<string, string[]>
  gitDirs: Set<string>
  hung: Set<string> | 'all'
  calls: FakeCall[]
  reset(): void
  isHung(fn: FakeCall['fn'], path: string): boolean
  pathsCalled(fn?: FakeCall['fn']): string[]
}

/** An in-memory stand-in for `node:fs/promises`: directories, git folders, hung paths and a call log. */
export const fakeFs: FakeFs = {
  /** Directory path -> names of its child directories. A path missing here does not exist. */
  dirs: new Map<string, string[]>(),
  /** Directories that hold a `.git` folder. */
  gitDirs: new Set<string>(),
  /** Paths whose calls never settle: `/path` for every call, or `readdir:/path` for one call. Or 'all'. */
  hung: new Set<string>(),
  calls: [],
  reset(): void {
    this.dirs.clear()
    this.gitDirs.clear()
    this.hung = new Set<string>()
    this.calls.length = 0
  },
  isHung(fn: FakeCall['fn'], path: string): boolean {
    return this.hung === 'all' || this.hung.has(path) || this.hung.has(`${fn}:${path}`)
  },
  pathsCalled(fn?: FakeCall['fn']): string[] {
    return this.calls.filter((call) => !fn || call.fn === fn).map((call) => call.path)
  }
}

function directoryEntry(name: string) {
  return { name, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }
}

export const fakeFsModule = {
  async readdir(path: string) {
    fakeFs.calls.push({ fn: 'readdir', path })
    if (fakeFs.isHung('readdir', path)) {
      return neverSettles()
    }
    const children = fakeFs.dirs.get(path)
    if (!children) {
      throw missing(path)
    }
    return children.map(directoryEntry)
  },
  async lstat(path: string) {
    fakeFs.calls.push({ fn: 'lstat', path })
    if (fakeFs.isHung('lstat', path)) {
      return neverSettles()
    }
    if (path.endsWith('/.git') && fakeFs.gitDirs.has(dirname(path))) {
      return { isDirectory: () => true, isFile: () => false }
    }
    throw missing(path)
  },
  async realpath(path: string) {
    fakeFs.calls.push({ fn: 'realpath', path })
    if (fakeFs.isHung('realpath', path)) {
      return neverSettles()
    }
    return path
  },
  async open(path: string) {
    fakeFs.calls.push({ fn: 'open', path })
    throw missing(join(path))
  }
}
