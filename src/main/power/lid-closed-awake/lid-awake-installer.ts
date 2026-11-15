import { userInfo } from 'node:os'
import { runMacPrivilegedCommand } from '../../cli/installation/cli-privileged-processes'
import type { LidAwakeSetupState } from '../../../shared/lid-closed-awake'
import {
  LID_HELPER_PATH,
  LID_HELPER_SOURCE,
  LID_HELPER_VERSION,
  LID_STATE_DIR
} from './lid-awake-helper-source'
import { runLidCommand } from './lid-awake-run-command'

export const LID_SUDOERS_PATH = '/etc/sudoers.d/orca-lid-hold'
// macOS short account names; the value reaches a sudoers file, so nothing else is accepted.
const SHORT_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/

const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

/** One root shell line: constants plus base64 payloads, so no user-writable file is read as root. */
export function buildInstallCommand(shortName: string): string {
  if (!SHORT_NAME_PATTERN.test(shortName)) {
    throw new Error('This account name cannot be used for the sudoers rule.')
  }
  const sudoers = [
    '# Managed by Orca (Stay awake with the lid closed). Remove it from Orca Settings > Agents.',
    `${shortName} ALL=(root) NOPASSWD: ${LID_HELPER_PATH} hold, ${LID_HELPER_PATH} reset`,
    ''
  ].join('\n')
  const stagedHelper = `${LID_HELPER_PATH}.new`
  const stagedSudoers = `${LID_SUDOERS_PATH}.new`
  return [
    'set -e',
    'umask 022',
    `trap '/bin/rm -f ${stagedHelper} ${stagedSudoers}' EXIT`,
    `/bin/mkdir -p /Library/PrivilegedHelperTools ${LID_STATE_DIR}`,
    `/usr/bin/printf %s ${base64(LID_HELPER_SOURCE)} | /usr/bin/base64 -D > ${stagedHelper}`,
    `/usr/sbin/chown root:wheel ${stagedHelper}`,
    `/bin/chmod 755 ${stagedHelper}`,
    `/usr/bin/printf %s ${base64(sudoers)} | /usr/bin/base64 -D > ${stagedSudoers}`,
    `/usr/sbin/chown root:wheel ${stagedSudoers}`,
    `/bin/chmod 440 ${stagedSudoers}`,
    `/usr/sbin/visudo -cf ${stagedSudoers}`,
    `/bin/mv -f ${stagedHelper} ${LID_HELPER_PATH}`,
    `/bin/mv -f ${stagedSudoers} ${LID_SUDOERS_PATH}`
  ].join('; ')
}

/** Clears the flag first when this helper set it, then removes every file the install created. */
export function buildRemoveCommand(): string {
  return [
    `if [ -e ${LID_STATE_DIR}/marker ]; then /usr/bin/pmset -a disablesleep 0; fi`,
    `/bin/rm -f ${LID_HELPER_PATH} ${LID_SUDOERS_PATH}`,
    `/bin/rm -rf ${LID_STATE_DIR}`
  ].join('; ')
}

export async function installLidHelper(shortName: string = userInfo().username): Promise<void> {
  await runMacPrivilegedCommand(buildInstallCommand(shortName))
}

export async function removeLidHelper(): Promise<void> {
  await runMacPrivilegedCommand(buildRemoveCommand())
}

/** `version` needs no root, so the setup state is read without any prompt. */
export async function readLidHelperSetupState(): Promise<LidAwakeSetupState> {
  const stdout = await runLidCommand(LID_HELPER_PATH, ['version'], 5_000)
  const match = stdout === null ? null : /orca-lid-hold (\d+)/.exec(stdout)
  if (!match) {
    return 'not-installed'
  }
  return Number(match[1]) < LID_HELPER_VERSION ? 'stale' : 'installed'
}
