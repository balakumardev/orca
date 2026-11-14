import { CUSTOM_UPDATE_REPO } from './custom-update-manifest'

/** Test seam: `http://127.0.0.1:<port>` replaces the GitHub API so a headless e2e can serve a fake release list. */
export const CUSTOM_UPDATE_FEED_URL_ENV = 'ORCA_CUSTOM_UPDATER_FEED_URL'
/** Lets a packaged build honor the feed override; an unpackaged build always may. */
export const CUSTOM_UPDATE_TEST_MODE_ENV = 'ORCA_CUSTOM_UPDATER_TEST'

export type CustomUpdateFeedOrigin = {
  apiBase: string
  /** Every asset URL the API names must start with this, so a response cannot point a download elsewhere. */
  assetUrlPrefix: string
  overridden: boolean
}

const PRODUCTION_ORIGIN: CustomUpdateFeedOrigin = {
  apiBase: 'https://api.github.com',
  assetUrlPrefix: `https://github.com/${CUSTOM_UPDATE_REPO}/releases/download/`,
  overridden: false
}

function parseLoopbackOrigin(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const isBareLoopbackOrigin =
    url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' &&
    /^\d{1,5}$/.test(url.port) &&
    url.pathname === '/' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  return isBareLoopbackOrigin ? url.origin : null
}

export function resolveCustomUpdateFeedOrigin(
  env: Record<string, string | undefined>,
  isPackaged: boolean
): CustomUpdateFeedOrigin {
  const override = env[CUSTOM_UPDATE_FEED_URL_ENV]
  if (!override || (isPackaged && env[CUSTOM_UPDATE_TEST_MODE_ENV] !== '1')) {
    return PRODUCTION_ORIGIN
  }
  const origin = parseLoopbackOrigin(override)
  return origin
    ? { apiBase: origin, assetUrlPrefix: `${origin}/`, overridden: true }
    : PRODUCTION_ORIGIN
}

// Hosts a release download may be served from: GitHub itself and the storage it redirects asset downloads to.
const RELEASE_HOSTS = [
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
]

/** Whether a request, or a redirect hop, may go to this URL. Production allows only these hosts over https. */
export function isAllowedFeedUrl(origin: CustomUpdateFeedOrigin, value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username || url.password) {
    return false
  }
  if (origin.overridden) {
    return url.origin === new URL(origin.apiBase).origin
  }
  return url.protocol === 'https:' && url.port === '' && RELEASE_HOSTS.includes(url.hostname)
}
