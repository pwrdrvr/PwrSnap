import {
  ChatThreadController,
  type ChatBackend,
  type ChatBroadcast,
  type ChatControllerEvent,
  type ChatThreadControllerDeps
} from "@pwrdrvr/agent-client";
import type {
  NormalizedThreadEvent,
  NormalizedTurnStatus,
  Unsubscribe
} from "@pwrdrvr/agent-core";

type TerminalTurn = { turnId: string; status: NormalizedTurnStatus };

/**
 * Interrupt-only bookkeeping for turns owned by one controller. It does not
 * annotate messages—that general terminal-status contract is owned by the
 * shared lifecycle layer. Raw events are accepted only for a turn first seen
 * through this controller's own streaming status, which prevents one surface
 * on a pooled ACP client from adopting/cancelling another surface's turn.
 */
class ChatInterruptState {
  private readonly activeByThread = new Map<string, string>();
  private readonly terminalByThread = new Map<string, TerminalTurn>();

  observeBackend(event: NormalizedThreadEvent): void {
    if (event.kind === "turn_completed") {
      if (this.activeTurn(event.threadId) === event.turnId) {
        this.terminalByThread.set(event.threadId, {
          turnId: event.turnId,
          status: event.status
        });
      }
      return;
    }
    if (
      event.kind === "error" &&
      event.threadId !== undefined &&
      event.turnId !== undefined &&
      event.willRetry !== true &&
      this.activeTurn(event.threadId) === event.turnId
    ) {
      this.terminalByThread.set(event.threadId, {
        turnId: event.turnId,
        status: "failed"
      });
    }
  }

  observeController(event: ChatControllerEvent): void {
    switch (event.type) {
      case "thread_updated":
        if (event.thread.status.kind === "streaming") {
          this.activeByThread.set(event.thread.threadId, event.thread.status.turnId);
        } else if (event.thread.status.kind === "idle") {
          this.activeByThread.delete(event.thread.threadId);
        }
        return;
      case "turn_interrupted":
        this.terminalByThread.set(event.threadId, {
          turnId: event.turnId,
          status: "interrupted"
        });
        if (this.activeTurn(event.threadId) === event.turnId) {
          this.activeByThread.delete(event.threadId);
        }
        return;
      default:
        return;
    }
  }

  activeTurn(threadId: string): string | null {
    return this.activeByThread.get(threadId) ?? null;
  }

  terminalStatus(threadId: string, turnId: string): NormalizedTurnStatus | null {
    const terminal = this.terminalByThread.get(threadId);
    return terminal?.turnId === turnId ? terminal.status : null;
  }
}

type SessionBackend = {
  client: ChatBackend;
  armInterrupt: (threadId: string) => void;
  disarmInterrupt: (threadId: string) => void;
};

/**
 * Give the kit controller a backend view that consumes one already-completed
 * interrupt request. Its event listener also observes authoritative terminal
 * events before the kit's asynchronous finalizer runs.
 */
function makeSessionBackend(
  backend: ChatBackend,
  state: ChatInterruptState
): SessionBackend {
  const armedInterrupts = new Set<string>();
  const client = new Proxy(backend, {
    get(target, property): unknown {
      if (property === "interruptTurn") {
        return async (threadId: string): Promise<void> => {
          if (armedInterrupts.delete(threadId)) return;
          await target.interruptTurn(threadId);
        };
      }
      if (property === "onEvent") {
        return (callback: (event: NormalizedThreadEvent) => void): Unsubscribe =>
          target.onEvent((event) => {
            state.observeBackend(event);
            callback(event);
          });
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    }
  }) as ChatBackend;

  return {
    client,
    armInterrupt: (threadId) => armedInterrupts.add(threadId),
    disarmInterrupt: (threadId) => armedInterrupts.delete(threadId)
  };
}

/**
 * PwrSnap's truthful interrupt controller.
 *
 * agent-client 0.8.2 swallows backend interrupt failures and can emit a stale
 * interruption after completion wins the awaited request. We preflight the
 * real cancellation, propagate a genuine failure, then only let the kit
 * finalize the same still-active turn. The proxy consumes the kit's duplicate
 * interrupt call.
 */
export class PwrSnapChatSessionController<
  TSettings = unknown
> extends ChatThreadController<TSettings> {
  private readonly backend: ChatBackend;
  private readonly state: ChatInterruptState;
  private readonly sessionBackend: SessionBackend;
  private readonly hostBroadcast: ChatBroadcast;
  private readonly interrupts = new Map<string, Promise<void>>();
  private readonly interruptedBroadcasts: Set<string>;

  constructor(deps: ChatThreadControllerDeps<TSettings>) {
    const state = new ChatInterruptState();
    const sessionBackend = makeSessionBackend(deps.client, state);
    const hostBroadcast = deps.broadcast;
    const interruptedBroadcasts = new Set<string>();
    super({
      ...deps,
      client: sessionBackend.client,
      broadcast: (event) => {
        state.observeController(event);
        if (event.type === "turn_interrupted") {
          interruptedBroadcasts.add(interruptedEventKey(event.threadId, event.turnId));
        }
        hostBroadcast(event);
      }
    });
    this.backend = deps.client;
    this.state = state;
    this.sessionBackend = sessionBackend;
    this.hostBroadcast = hostBroadcast;
    this.interruptedBroadcasts = interruptedBroadcasts;
  }

  override interrupt(threadId: string): Promise<void> {
    const existing = this.interrupts.get(threadId);
    if (existing !== undefined) return existing;

    const turnId = this.state.activeTurn(threadId);
    if (turnId === null) return Promise.resolve();
    const knownTerminal = this.state.terminalStatus(threadId, turnId);
    if (knownTerminal !== null) {
      this.emitBackendInterruption(threadId, turnId, knownTerminal);
      return Promise.resolve();
    }

    const running = (async (): Promise<void> => {
      try {
        await this.backend.interruptTurn(threadId);
      } catch (cause) {
        const terminal = this.state.terminalStatus(threadId, turnId);
        if (terminal !== null) {
          this.emitBackendInterruption(threadId, turnId, terminal);
          return;
        }
        if (this.state.activeTurn(threadId) !== turnId) return;
        throw cause;
      }

      const terminal = this.state.terminalStatus(threadId, turnId);
      if (terminal !== null) {
        this.emitBackendInterruption(threadId, turnId, terminal);
        return;
      }
      if (this.state.activeTurn(threadId) !== turnId) return;

      this.sessionBackend.armInterrupt(threadId);
      try {
        await super.interrupt(threadId);
      } finally {
        this.sessionBackend.disarmInterrupt(threadId);
      }
    })();

    this.interrupts.set(threadId, running);
    void running
      .finally(() => {
        if (this.interrupts.get(threadId) === running) {
          this.interrupts.delete(threadId);
        }
      })
      .catch(() => undefined);
    return running;
  }

  /**
   * Stronger quiescence seam used before approval denial/archive. A broker
   * request proves the backend may still be awaiting a decision even when a
   * reconstructed controller has not observed its streaming status. In that
   * narrow case, require a direct backend acknowledgement instead of treating
   * the missing local turn as an idle no-op.
   */
  interruptAcknowledged(threadId: string): Promise<void> {
    return this.state.activeTurn(threadId) === null
      ? this.backend.interruptTurn(threadId)
      : this.interrupt(threadId);
  }

  private emitBackendInterruption(
    threadId: string,
    turnId: string,
    status: NormalizedTurnStatus
  ): void {
    if (status !== "cancelled" && status !== "interrupted") return;
    const key = interruptedEventKey(threadId, turnId);
    if (this.interruptedBroadcasts.has(key)) return;
    this.interruptedBroadcasts.add(key);
    this.hostBroadcast({ type: "turn_interrupted", threadId, turnId });
  }
}

function interruptedEventKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}
