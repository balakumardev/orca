/** Tracks one lid-closed stretch so a summary can be shown when the lid reopens. */
export class LidWatch {
  private closedSince: number | null = null
  private batteryAtClose: number | null = null

  get isClosed(): boolean {
    return this.closedSince !== null
  }

  async poll(
    readLidClosed: () => Promise<boolean | null>,
    now: number,
    batteryPercent: number | null
  ): Promise<{ heldMs: number; batteryFrom: number | null } | null> {
    const closed = await readLidClosed()
    return closed === null ? null : this.observe(closed, now, batteryPercent)
  }

  /** Returns the finished stretch when this reading shows the lid reopening. */
  observe(
    closed: boolean,
    now: number,
    batteryPercent: number | null
  ): { heldMs: number; batteryFrom: number | null } | null {
    if (closed && this.closedSince === null) {
      this.closedSince = now
      this.batteryAtClose = batteryPercent
      return null
    }
    if (closed || this.closedSince === null) {
      return null
    }
    const ended = { heldMs: now - this.closedSince, batteryFrom: this.batteryAtClose }
    this.closedSince = null
    this.batteryAtClose = null
    return ended
  }
}
