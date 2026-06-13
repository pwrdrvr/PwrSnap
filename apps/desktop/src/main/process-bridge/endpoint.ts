// Symmetric endpoint for the agent ↔ library process bridge. Each main
// process constructs one over its side of the pipe:
//
//   • outbound: `dispatchRemote(name, req)` runs a command on the peer
//     and resolves the peer's Result. Never rejects — transport failures
//     come back as `Result.err` (`bridge_closed` / `bridge_send_failed`),
//     matching the repo-wide rule that errors never throw across process
//     boundaries.
//   • inbound: requests from the peer flow into the injected
//     `dispatchLocal` (Phase 2 wires `bus.dispatch` with
//     `principal: "bridge"`).
//   • events: `emitEvent` forwards a renderer broadcast to the peer once;
//     incoming peer events surface via `onRemoteEvent`. There is no
//     automatic re-forwarding, so relay loops are impossible at this
//     layer — each process emits to its own windows plus exactly one
//     `emitEvent` call.
//
// Dependencies are injected (channel, local dispatch, logger) so this
// module stays Electron-free and unit-testable against the in-memory
// channel pair.

import { err, ok, type PwrSnapError, type Result } from "@pwrsnap/shared";
import type { ProcessRole } from "../process-role";
import type { BridgeChannel } from "./channel";
import {
  BRIDGE_PROTOCOL_VERSION,
  isBridgeMessage,
  sanitizeResultForBridge,
  type BridgeMessage
} from "./protocol";

export type BridgeLocalDispatch = (
  name: string,
  req: unknown
) => Promise<Result<unknown, PwrSnapError>>;

export type BridgeEndpointOptions = {
  /** This process's role, announced to the peer in the hello frame. */
  role: ProcessRole;
  channel: BridgeChannel;
  dispatchLocal: BridgeLocalDispatch;
  /** Peer-originated renderer events (channel, payload). */
  onRemoteEvent?: (channel: string, payload: unknown) => void;
  /** Peer-originated cancellation keys (wire to `bus.cancel`). */
  onRemoteCancel?: (key: string) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
};

function bridgeError(code: string, message: string): Result<never, PwrSnapError> {
  return err({ kind: "unknown", code, message });
}

export class BridgeEndpoint {
  private readonly options: BridgeEndpointOptions;
  private readonly pending = new Map<number, (result: Result<unknown, PwrSnapError>) => void>();
  private readonly unsubscribe: Array<() => void> = [];
  private nextRequestId = 1;
  private closed = false;
  private peer: ProcessRole | null = null;
  private peerWaiters: Array<{
    resolve: (result: Result<ProcessRole, PwrSnapError>) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(options: BridgeEndpointOptions) {
    this.options = options;
    this.unsubscribe.push(options.channel.onMessage((message) => this.handleMessage(message)));
    this.unsubscribe.push(options.channel.onClose(() => this.handleClosed()));
    options.channel.send({
      pwrsnapBridge: BRIDGE_PROTOCOL_VERSION,
      kind: "hello",
      role: options.role,
      pid: process.pid
    });
  }

  /** The peer's announced role, or null before its hello arrives. */
  get peerRole(): ProcessRole | null {
    return this.peer;
  }

  /**
   * Resolve once the peer's hello arrives (it sends hello only after
   * its command handlers are registered). The readiness gate matters
   * on the agent side: Node IPC messages sent before the child process
   * attaches its `message` listener are dropped, so dispatching into a
   * freshly-spawned library before its hello loses the request.
   * Resolves `err(bridge_timeout)` / `err(bridge_closed)` rather than
   * rejecting, per the transport-failure convention.
   */
  waitForPeer(timeoutMs: number): Promise<Result<ProcessRole, PwrSnapError>> {
    if (this.peer !== null) return Promise.resolve(ok(this.peer));
    if (this.closed) {
      return Promise.resolve(bridgeError("bridge_closed", "bridge closed before peer hello"));
    }
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this.peerWaiters = this.peerWaiters.filter((w) => w !== waiter);
          resolve(bridgeError("bridge_timeout", `peer hello not seen within ${timeoutMs}ms`));
        }, timeoutMs)
      };
      this.peerWaiters.push(waiter);
    });
  }

  async dispatchRemote(name: string, req: unknown): Promise<Result<unknown, PwrSnapError>> {
    if (this.closed) {
      return bridgeError("bridge_closed", `bridge closed; cannot dispatch ${name}`);
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const result = new Promise<Result<unknown, PwrSnapError>>((resolve) => {
      this.pending.set(id, resolve);
    });
    const sent = this.options.channel.send({
      pwrsnapBridge: BRIDGE_PROTOCOL_VERSION,
      kind: "request",
      id,
      name,
      req
    });
    if (!sent) {
      this.pending.delete(id);
      return bridgeError("bridge_send_failed", `bridge send failed for ${name}`);
    }
    return result;
  }

  /** Forward one renderer event to the peer (fire-and-forget). */
  emitEvent(channel: string, payload: unknown): void {
    if (this.closed) return;
    const sent = this.options.channel.send({
      pwrsnapBridge: BRIDGE_PROTOCOL_VERSION,
      kind: "event",
      channel,
      payload
    });
    if (!sent) {
      this.options.warn?.("bridge: event send failed", { channel });
    }
  }

  /** Ask the peer to abort in-flight work keyed by `key`
   *  (fire-and-forget — a dead peer has nothing to cancel). */
  cancelRemote(key: string): void {
    if (this.closed) return;
    this.options.channel.send({
      pwrsnapBridge: BRIDGE_PROTOCOL_VERSION,
      kind: "cancel",
      key
    });
  }

  /** Detach from the channel and fail anything in flight. Idempotent. */
  close(): void {
    this.handleClosed();
    for (const detach of this.unsubscribe.splice(0)) detach();
  }

  private handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const resolve of pending) {
      resolve(bridgeError("bridge_closed", "bridge closed while request was in flight"));
    }
    const waiters = this.peerWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(bridgeError("bridge_closed", "bridge closed before peer hello"));
    }
  }

  private handleMessage(raw: unknown): void {
    if (this.closed || !isBridgeMessage(raw)) return;
    const message: BridgeMessage = raw;
    switch (message.kind) {
      case "hello": {
        this.peer = message.role;
        const waiters = this.peerWaiters.splice(0);
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(ok(message.role));
        }
        return;
      }
      case "request":
        void this.serveRequest(message.id, message.name, message.req);
        return;
      case "response": {
        const resolve = this.pending.get(message.id);
        if (resolve === undefined) {
          this.options.warn?.("bridge: response for unknown request", { id: message.id });
          return;
        }
        this.pending.delete(message.id);
        resolve(message.result);
        return;
      }
      case "event":
        this.options.onRemoteEvent?.(message.channel, message.payload);
        return;
      case "cancel":
        this.options.onRemoteCancel?.(message.key);
        return;
    }
  }

  private async serveRequest(id: number, name: string, req: unknown): Promise<void> {
    let result: Result<unknown, PwrSnapError>;
    try {
      result = await this.options.dispatchLocal(name, req);
    } catch (cause) {
      // dispatchLocal is bus.dispatch, which already catches and wraps —
      // this is a second net for wiring mistakes, not a normal path.
      result = bridgeError(
        "bridge_dispatch_threw",
        cause instanceof Error ? cause.message : String(cause)
      );
    }
    const sent = this.options.channel.send({
      pwrsnapBridge: BRIDGE_PROTOCOL_VERSION,
      kind: "response",
      id,
      result: sanitizeResultForBridge(result)
    });
    if (!sent) {
      this.options.warn?.("bridge: response send failed", { id, name });
    }
  }
}
