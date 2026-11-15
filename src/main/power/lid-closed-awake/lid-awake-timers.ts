type Handle = ReturnType<typeof setTimeout>

/** Named timers that never keep the process alive; setting a name that is already running is a no-op. */
export class NamedTimers {
  private readonly handles = new Map<string, Handle>()

  has(name: string): boolean {
    return this.handles.has(name)
  }

  after(name: string, ms: number, run: () => void): void {
    if (this.handles.has(name)) {
      return
    }
    const handle = setTimeout(() => {
      this.handles.delete(name)
      run()
    }, ms)
    handle.unref?.()
    this.handles.set(name, handle)
  }

  every(name: string, ms: number, run: () => void): void {
    if (this.handles.has(name)) {
      return
    }
    const handle = setInterval(run, ms)
    handle.unref?.()
    this.handles.set(name, handle)
  }

  clear(name: string): void {
    const handle = this.handles.get(name)
    if (handle) {
      clearTimeout(handle)
      clearInterval(handle)
      this.handles.delete(name)
    }
  }

  clearAll(): void {
    for (const handle of this.handles.values()) {
      clearTimeout(handle)
      clearInterval(handle)
    }
    this.handles.clear()
  }
}
