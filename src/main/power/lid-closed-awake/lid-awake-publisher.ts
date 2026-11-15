/** Fans a state out to listeners, skipping a state identical to the last one sent. */
export class StatePublisher<T> {
  private readonly listeners = new Set<(state: T) => void>()
  private last = ''

  subscribe(listener: (state: T) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(state: T): void {
    const key = JSON.stringify(state)
    if (key === this.last) {
      return
    }
    this.last = key
    for (const listener of this.listeners) {
      listener(state)
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
