// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import { getPaletteSearchHosts, isPaletteSearchHostCurrent } from './palette-search-hosts'
import {
  paletteRuntimeEnvironment,
  paletteRuntimeStatus
} from './palette-runtime-host.test-fixture'

const initialState = useAppStore.getInitialState()

describe('palette search authorities', () => {
  it('does not contact a configured host with only retained status metadata', () => {
    const environment = paletteRuntimeEnvironment('intbox')
    const { snapshot: _snapshot, ...retained } = paletteRuntimeStatus(environment)
    const state = {
      ...initialState,
      runtimeEnvironments: [environment],
      runtimeStatusByEnvironmentId: new Map([['intbox', retained]])
    }
    expect(getPaletteSearchHosts(state).map((host) => host.executionHostId)).toEqual(['local'])
  })

  it('includes local and live configured hosts without treating focused or cached hosts as sources', () => {
    const online = paletteRuntimeEnvironment('intbox')
    const offline = paletteRuntimeEnvironment('offline')
    const ghost = paletteRuntimeEnvironment('removed')
    const state = {
      ...initialState,
      settings: { ...initialState.settings!, activeRuntimeEnvironmentId: 'intbox' },
      runtimeEnvironments: [online, offline],
      runtimeStatusByEnvironmentId: new Map([
        ['intbox', paletteRuntimeStatus(online)],
        ['removed', paletteRuntimeStatus(ghost)]
      ])
    }
    expect(getPaletteSearchHosts(state).map((host) => host.executionHostId)).toEqual([
      'local',
      'runtime:intbox'
    ])
    expect(
      getPaletteSearchHosts(state, ['local']).map((host) => host.runtimeEnvironmentId)
    ).toEqual([null])
    expect(getPaletteSearchHosts(state, ['ssh:unpaired'])).toEqual([])
  })

  it('deduplicates proven runtime aliases but keeps computers with the same display name', () => {
    const first = { ...paletteRuntimeEnvironment('intbox'), name: 'Builder' }
    const alias = { ...paletteRuntimeEnvironment('intbox-alias'), runtimeId: first.runtimeId }
    const other = { ...paletteRuntimeEnvironment('other'), name: 'Builder' }
    const state = {
      ...initialState,
      runtimeEnvironments: [first, alias, other],
      runtimeStatusByEnvironmentId: new Map([
        ['intbox', paletteRuntimeStatus(first)],
        ['intbox-alias', paletteRuntimeStatus(alias)],
        ['other', paletteRuntimeStatus(other)]
      ])
    }
    expect(getPaletteSearchHosts(state).map((host) => host.executionHostId)).toEqual([
      'local',
      'runtime:intbox',
      'runtime:other'
    ])
  })

  it('expands a managed SSH filter to its paired search authority', () => {
    const managed = {
      ...paletteRuntimeEnvironment('intbox'),
      orcadDeployment: {
        sshTargetId: 'ssh-intbox',
        sshTargetGeneration: 1,
        localPort: 7001,
        remotePort: 7001
      }
    }
    const state = {
      ...initialState,
      sshTargetLabels: new Map([['ssh-intbox', 'Intbox']]),
      runtimeEnvironments: [managed],
      runtimeStatusByEnvironmentId: new Map([['intbox', paletteRuntimeStatus(managed)]])
    }
    expect(
      getPaletteSearchHosts(state, ['ssh:ssh-intbox']).map((host) => host.executionHostId)
    ).toEqual(['runtime:intbox'])
  })

  it('keeps an action valid across status heartbeats but refuses replacement pairings and connections', () => {
    const environment = paletteRuntimeEnvironment('intbox')
    const status = paletteRuntimeStatus(environment)
    const state = {
      ...initialState,
      runtimeEnvironments: [environment],
      runtimeStatusByEnvironmentId: new Map([['intbox', status]])
    }
    const host = getPaletteSearchHosts(state, ['runtime:intbox'])[0]!
    expect(
      isPaletteSearchHostCurrent(host, {
        ...state,
        runtimeStatusByEnvironmentId: new Map([['intbox', { ...status, checkedAt: 100 }]])
      })
    ).toBe(true)
    expect(
      isPaletteSearchHostCurrent(host, {
        ...state,
        runtimeEnvironments: [{ ...environment, pairingRevision: 2 }]
      })
    ).toBe(false)
    expect(
      isPaletteSearchHostCurrent(host, {
        ...state,
        runtimeStatusByEnvironmentId: new Map([['intbox', { ...status, connectionGeneration: 2 }]])
      })
    ).toBe(false)
  })
})
