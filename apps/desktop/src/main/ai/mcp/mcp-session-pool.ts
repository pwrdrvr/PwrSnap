/** Admission and revocation cleanup share a queue. Awaiting policy reads must
 * never allow concurrent replacements to pass the same capacity check. */
export class McpSessionPool<T> {
  private readonly sessions = new Map<number, T>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly limit: number,
    private readonly valid: (value: T) => Promise<boolean>,
    private readonly close: (value: T) => Promise<void>
  ) {}
  private serialize<R>(work: () => Promise<R>): Promise<R> {
    const next = this.queue.catch(() => undefined).then(work);
    this.queue = next;
    return next;
  }
  private async pruneNow(): Promise<void> {
    for (const [id, value] of this.sessions) {
      if (!(await this.valid(value))) {
        this.sessions.delete(id);
        await this.close(value);
      }
    }
  }
  admit(id: number, value: T): Promise<boolean> {
    return this.serialize(async () => {
      await this.pruneNow();
      if (this.sessions.has(id) || this.sessions.size >= this.limit || !(await this.valid(value)))
        return false;
      this.sessions.set(id, value);
      return true;
    });
  }
  prune(): Promise<void> {
    return this.serialize(() => this.pruneNow());
  }
  remove(id: number): void {
    this.sessions.delete(id);
  }
  values(): T[] {
    return [...this.sessions.values()];
  }
  async clear(): Promise<void> {
    await this.serialize(async () => {
      const values = [...this.sessions.values()];
      this.sessions.clear();
      await Promise.all(values.map((value) => this.close(value)));
    });
  }
}
