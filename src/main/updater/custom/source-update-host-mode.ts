/** The managed Mac source desktop owns its profile across build generations. */
export function isManagedSourceUpdateHost(options: {
  isPackaged: boolean
  isServeMode: boolean
}): boolean {
  return (
    process.platform === 'darwin' &&
    !options.isPackaged &&
    !options.isServeMode &&
    process.env.ORCA_SOURCE_UPDATE_HANDOFF === '1'
  )
}
