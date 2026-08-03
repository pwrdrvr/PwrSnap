export type ManagedLocalAgentMcpServer = {
  start(): Promise<unknown>;
  stop(): Promise<void>;
};

/** Serializes the live MCP listener's start/stop transitions. Settings writes
 * can overlap their broadcasts, so a rapid on→off must not leave a server
 * listening after the final saved state is off. */
export class LocalAgentMcpLifecycle {
  private readonly createServer: () => ManagedLocalAgentMcpServer;
  private readonly onStartError: (cause: unknown) => void;
  private desiredEnabled = false;
  private server: ManagedLocalAgentMcpServer | null = null;
  private transition: Promise<void> = Promise.resolve();

  constructor(options: {
    createServer: () => ManagedLocalAgentMcpServer;
    onStartError?: (cause: unknown) => void;
  }) {
    this.createServer = options.createServer;
    this.onStartError = options.onStartError ?? (() => undefined);
  }

  setEnabled(enabled: boolean): Promise<void> {
    this.desiredEnabled = enabled;
    const next = this.transition
      .catch(() => undefined)
      .then(() => this.reconcile());
    this.transition = next;
    return next;
  }

  private async reconcile(): Promise<void> {
    while (true) {
      const target = this.desiredEnabled;
      if (target && this.server === null) {
        const candidate = this.createServer();
        this.server = candidate;
        try {
          await candidate.start();
        } catch (cause) {
          if (this.server === candidate) this.server = null;
          await candidate.stop().catch(() => undefined);
          this.onStartError(cause);
          return;
        }
      } else if (!target && this.server !== null) {
        const active = this.server;
        this.server = null;
        await active.stop();
      }

      if (target === this.desiredEnabled) return;
    }
  }
}
