import { z } from 'zod'
import type { ParsedExecutionHost } from '../../shared/execution-host/execution-host'
import { FOLDER_SEARCH_CAPABILITY } from '../../shared/folder-search-types'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime/remote-runtime-client-error'
import {
  listEnvironments,
  resolveEnvironment
} from '../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  getOrcadSshDeployment,
  getPreferredPairedRuntimeConnection
} from '../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  getRuntimeEnvironmentStatusSnapshot,
  isRemoteRuntimeConnectionReady
} from '../ipc/runtime-environments/connections/runtime-environment-request-connections'
import { isRuntimeEnvironmentManuallyDisconnected } from '../ipc/runtime-environments/connectivity/runtime-environment-manual-disconnect'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/requests/runtime-environment-transport-routing'
import { DEFAULT_FOLDER_SCAN_LIMITS } from './folder-search-scan'

type RemoteFolderSearchHost = Exclude<ParsedExecutionHost, { kind: 'local' }>

// Only folder data crosses the boundary; main supplies the addressed execution host afterward.
const entrySchema = z.object({
  path: z.string().min(1),
  realPath: z.string().min(1).optional(),
  kind: z.enum(['git-root', 'linked-worktree', 'folder'])
})
const resultSchema = z.object({
  entries: z.array(entrySchema).max(DEFAULT_FOLDER_SCAN_LIMITS.maxEntries),
  truncated: z.boolean()
})

async function callFolderSearch(
  userDataPath: string,
  host: RemoteFolderSearchHost,
  method: 'folderSearch.list' | 'folderSearch.resolve',
  params: unknown
): Promise<unknown> {
  // SSH targets use their paired Orca server, exactly like directly paired runtimes.
  const environments =
    host.kind === 'runtime'
      ? [await resolveEnvironment(userDataPath, host.environmentId)]
      : (await listEnvironments(userDataPath)).filter(
          (environment) => getOrcadSshDeployment(environment)?.sshTargetId === host.targetId
        )
  const environment = environments.length === 1 ? environments[0] : undefined
  if (!environment) {
    throw new RemoteRuntimeClientError(
      'runtime_unavailable',
      'Folder search needs a paired Orca server.'
    )
  }
  const snapshot = getRuntimeEnvironmentStatusSnapshot(environment.id)
  const pairingRevision = environment.pairingRevision ?? environment.createdAt
  if (
    isRuntimeEnvironmentManuallyDisconnected(environment.id) ||
    !isRemoteRuntimeConnectionReady(
      environment.id,
      getPreferredPairedRuntimeConnection(environment)
    ) ||
    !snapshot?.status ||
    snapshot.retired ||
    snapshot.verification !== 'verified' ||
    snapshot.pairingRevision !== pairingRevision
  ) {
    throw new RemoteRuntimeClientError(
      'runtime_unavailable',
      'Folder search needs a connected Orca server.'
    )
  }
  if (!snapshot.status.capabilities?.includes(FOLDER_SEARCH_CAPABILITY)) {
    throw new RemoteRuntimeClientError(
      'unsupported_method',
      'This Orca server does not support folder search. Update the server to use it.'
    )
  }
  const response = await callRuntimeEnvironment(
    userDataPath,
    environment.id,
    method,
    params,
    undefined,
    pairingRevision,
    undefined,
    {
      expectedEnvironmentRuntimeId: snapshot.status.runtimeId,
      preparation: { wslStart: 'never' }
    }
  )
  if (!response.ok) {
    throw new RemoteRuntimeClientError(response.error.code, response.error.message)
  }
  return response.result
}

export async function listRuntimeFolders(userDataPath: string, host: RemoteFolderSearchHost) {
  return resultSchema.parse(
    await callFolderSearch(userDataPath, host, 'folderSearch.list', undefined)
  )
}

export async function resolveRuntimeFolder(
  userDataPath: string,
  host: RemoteFolderSearchHost,
  path: string
) {
  return entrySchema
    .nullable()
    .parse(await callFolderSearch(userDataPath, host, 'folderSearch.resolve', { path }))
}
