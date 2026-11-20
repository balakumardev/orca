import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isProjectAgentAccountId } from '../../../shared/project-agent-accounts'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'

/** Accounts and System default live in separate folders, so an account named `system` cannot collide. */
export type ProjectClaudePointerName = { kind: 'account'; accountId: string } | { kind: 'system' }

export function projectClaudePointerPath(dataRoot: string, name: ProjectClaudePointerName): string {
  const root = join(dataRoot, 'project-agent-accounts', 'pointers', 'claude')
  if (name.kind === 'system') {
    return join(root, 'system')
  }
  if (!isProjectAgentAccountId(name.accountId)) {
    throw new Error('Invalid Claude account id')
  }
  return join(root, 'accounts', name.accountId)
}

/** An empty pointer means System default; rewrite only on change, as the global pointer does. */
export function writeProjectClaudePointer(pointerPath: string, home: string): void {
  if (existsSync(pointerPath) && readFileSync(pointerPath, 'utf8') === home) {
    return
  }
  mkdirSync(dirname(pointerPath), { recursive: true, mode: 0o700 })
  writeFileAtomically(pointerPath, home, { mode: 0o600 })
}

/** A missing pointer reads as System default and the shell function never creates a folder for it. */
export function removeProjectClaudePointer(pointerPath: string): void {
  rmSync(pointerPath, { force: true })
}
