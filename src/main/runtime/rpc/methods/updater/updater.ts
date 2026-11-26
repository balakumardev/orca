import { defineMethod } from '../../core'
import { SOURCE_UPDATE_HANDOFF_METHODS } from '../../../../updater/custom/source-update-handoff-rpc'
import {
  checkRemoteServerUpdater,
  downloadRemoteServerUpdater,
  getRemoteServerUpdaterSnapshot,
  installRemoteServerUpdater
} from '../../../hosts/management/remote-server-updater'
import { UpdaterCheckParams } from '../../../../../shared/rpc-contract/updater/updater-params'

export const UPDATER_METHODS = [
  // Source installs hand off to their external launcher through the same authenticated transport.
  ...SOURCE_UPDATE_HANDOFF_METHODS,
  defineMethod({
    name: 'updater.getStatus',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => getRemoteServerUpdaterSnapshot(runtime.getRuntimeId())
  }),
  defineMethod({
    name: 'updater.check',
    permission: 'host-admin',
    params: UpdaterCheckParams,
    handler: (params, { runtime }) => checkRemoteServerUpdater(runtime.getRuntimeId(), params)
  }),
  defineMethod({
    name: 'updater.download',
    permission: 'host-admin',
    params: null,
    handler: (_params, { runtime }) => downloadRemoteServerUpdater(runtime.getRuntimeId())
  }),
  defineMethod({
    name: 'updater.install',
    permission: 'host-admin',
    params: null,
    handler: (_params, { runtime }) => installRemoteServerUpdater(runtime.getRuntimeId())
  })
]
