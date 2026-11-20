import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV,
  CLAUDE_USER_CONFIG_DIR_ENV
} from '../../../shared/agent-accounts/claude/claude-profile-routing'
import type { ClaudeRuntimeAuthPreparation } from '../runtime-auth/runtime-auth-types'

/** `system` also covers an account that runs on the matching System default login. */
export type ProjectClaudeRoute =
  | { kind: 'account'; accountId: string; home: string; pointerPath: string }
  | { kind: 'system'; pointerPath: string }

export function projectClaudePointerContent(route: ProjectClaudeRoute): string {
  return route.kind === 'account' ? route.home : ''
}

/** Same shape as ClaudeProfileRouter.preparation(), for the pinned route. */
export function projectClaudePreparation(
  route: ProjectClaudeRoute,
  systemDefaultHome: string
): ClaudeRuntimeAuthPreparation {
  if (route.kind === 'account') {
    return {
      configDir: route.home,
      runtime: 'host',
      wslDistro: null,
      wslLinuxConfigDir: null,
      envPatch: {
        [CLAUDE_PROFILE_POINTER_ENV]: route.pointerPath,
        CLAUDE_CONFIG_DIR: route.home,
        [CLAUDE_INJECTED_CONFIG_DIR_ENV]: route.home
      },
      provenance: `profile:${route.accountId}`
    }
  }
  return {
    configDir: systemDefaultHome,
    runtime: 'host',
    wslDistro: null,
    wslLinuxConfigDir: null,
    envPatch: { [CLAUDE_PROFILE_POINTER_ENV]: route.pointerPath },
    provenance: 'system'
  }
}

/** Replaces the active account's terminal env with the pinned route; returns a copy because splits share env. */
export function applyProjectClaudeRouteEnv(
  env: Record<string, string> | undefined,
  route: ProjectClaudeRoute
): Record<string, string> {
  const next: Record<string, string> = { ...env, [CLAUDE_PROFILE_POINTER_ENV]: route.pointerPath }
  if (route.kind === 'account') {
    next.CLAUDE_CONFIG_DIR = route.home
    next[CLAUDE_INJECTED_CONFIG_DIR_ENV] = route.home
    return next
  }
  // Undo only Orca's injection; the user's own spelling keeps their Keychain identity.
  const injected = next[CLAUDE_INJECTED_CONFIG_DIR_ENV]
  if (injected !== undefined && next.CLAUDE_CONFIG_DIR === injected) {
    delete next.CLAUDE_CONFIG_DIR
    const own = next[CLAUDE_USER_CONFIG_DIR_ENV]
    if (own) {
      next.CLAUDE_CONFIG_DIR = own
    }
  }
  delete next[CLAUDE_INJECTED_CONFIG_DIR_ENV]
  return next
}
