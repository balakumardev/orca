import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  DEFAULT_LID_AWAKE_CONFIG,
  normalizeLidAwakeConfig,
  type LidAwakeConfig
} from '../../../shared/lid-closed-awake'

export const LID_AWAKE_CONFIG_FILE_NAME = 'lid-closed-awake.json'

export async function loadLidAwakeConfig(path: string): Promise<LidAwakeConfig> {
  try {
    return normalizeLidAwakeConfig(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return { ...DEFAULT_LID_AWAKE_CONFIG }
  }
}

/**
 * Writes queue behind each other so the file always ends with the latest setting. A failed write
 * only costs the setting surviving a restart, so it is logged and never rejects.
 */
export function createLidAwakeConfigWriter(
  path: string
): (config: LidAwakeConfig) => Promise<void> {
  let queue: Promise<void> = Promise.resolve()
  return (config) => {
    queue = queue.then(async () => {
      try {
        await mkdir(dirname(path), { recursive: true })
        const staged = `${path}.tmp`
        await writeFile(staged, JSON.stringify(config))
        await rename(staged, path)
      } catch (error) {
        console.warn('[lid-awake] could not save the setting', error)
      }
    })
    return queue
  }
}
