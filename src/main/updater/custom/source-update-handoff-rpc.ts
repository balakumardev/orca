import { defineMethod } from '../../runtime/rpc/core'
import { requestSourceUpdateQuit } from './source-update-handoff'

/** The external source updater uses the existing owner-authenticated local transport. */
export const SOURCE_UPDATE_HANDOFF_METHODS = [
  defineMethod({
    name: 'updater.quitForSourceUpdate',
    permission: 'host-admin',
    params: null,
    handler: (_params, { caller, plugin }) => requestSourceUpdateQuit(plugin ? undefined : caller)
  })
]
